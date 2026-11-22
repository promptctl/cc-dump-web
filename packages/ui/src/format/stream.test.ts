import { describe, expect, it } from "vitest";
import { createReassembly } from "./stream.ts";

// A stream's text reassembled all at once.
const reassemble = (text: string, complete: boolean) => createReassembly().reassemble(text, complete);

const event = (data: object, eol = "\n") => `event: ${(data as { type: string }).type}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
const messageStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 2 } } };

// A stream as Anthropic sends one: a text block, a tool whose input streams in pieces, an error, a ping.
const stream = (eol: string) =>
  [
    messageStart,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "ls"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "ping" },
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: "message_stop", metrics: { ms: 1 } },
  ]
    .map((data) => event(data, eol))
    .join("");

describe("createReassembly", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("reassembles a stream whose lines end in %s, fed in two pieces at every split, as it does whole", (_, eol) => {
    const text = stream(eol);
    const whole = reassemble(text, true);
    // The stop's field shows its event was applied: a stream's last event is applied once its text is complete.
    expect(whole).toMatchObject({
      reply: {
        blocks: [
          { index: 0, is: "whole", block: { type: "text", text: "Hello, world." } },
          { index: 1, is: "whole", block: { type: "tool_use", input: { command: "ls" } } },
        ],
        stop: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 2, output_tokens: 9 },
        events: [{ at: ["message_stop", "metrics"], value: { ms: 1 } }],
      },
      blocks: [],
      tail: "",
    });
    for (let at = 0; at <= text.length; at++) {
      const reassembly = createReassembly();
      expect(reassembly.reassemble(text.slice(0, at), false), `split at ${at}`).toEqual(reassemble(text.slice(0, at), false));
      expect(reassembly.reassemble(text, true), `split at ${at}`).toEqual(whole);
    }
  });

  it("returns a stream of its own each time, which later events do not change", () => {
    const reassembly = createReassembly();
    const text = stream("\n");
    const at = text.indexOf("world");
    const early = reassembly.reassemble(text.slice(0, at), false);
    const copy = structuredClone(early);
    reassembly.reassemble(text, true);
    expect(early).toEqual(copy);
  });

  it("holds a tool's input as the text sent so far until its block stops, and the block as its start sent it", () => {
    const text = stream("\n");
    const sofar = reassemble(text.slice(0, text.indexOf('"content_block_stop","index":1')), false);
    expect(sofar.reply!.blocks[1]).toEqual({
      index: 1,
      events: [],
      is: "arriving",
      arriving: { start: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }, grows: { by: "input", input: '{"command": "ls"}' } },
    });
  });

  it("holds each block by its index in the stream, whatever order they start in", () => {
    const text = [
      messageStart,
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "second" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } },
    ]
      .map((data) => event(data))
      .join("");
    expect(reassemble(text, false).reply!.blocks.map(({ index }) => index)).toEqual([0, 1]);
  });

  // The events a stream with one text block sends, `last` among them after its stop.
  const texted = (...last: object[]) =>
    [messageStart, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_stop", index: 0 }, ...last].map((data) => event(data)).join("");
  const notApplied = ({ blocks }: { blocks: { name: string; parts: unknown[] }[] }) => blocks.map(({ name, parts }) => [name, (parts[0] as { text: string }).text]);

  it("shows an event that does not follow the events before it, with why, and changes nothing", () => {
    const text = texted({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } }, { type: "message_stop" }, { type: "message_stop" }, { type: "error", error: { type: "overloaded_error" } });
    const stream = reassemble(text, true);
    expect(notApplied(stream)).toEqual([
      ["content_block_delta event", "content block 0 has stopped"],
      ["message_stop event", "the message has stopped"],
      ["error event", "the message has stopped"],
    ]);
    expect(stream.reply!.blocks).toEqual([{ index: 0, events: [], is: "whole", block: { type: "text", text: "" } }]);
    expect(stream.errors).toEqual([]);
  });

  it("refuses a message_stop while a block is still arriving; a tool's input that is not JSON stops its block refused, so the message can stop", () => {
    const tool = { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } };
    const half = { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } };
    const stream = reassemble(texted(tool, half, { type: "message_stop" }, { type: "content_block_stop", index: 1 }, { type: "message_stop" }), true);
    expect(notApplied(stream)).toEqual([["message_stop event", "content block 1 is still arriving"]]);
    expect(stream.reply!.blocks[1]).toEqual({
      index: 1,
      events: [],
      is: "refused",
      why: expect.stringMatching(/^its streamed input is not JSON: /),
      block: { ...tool.content_block, input: '{"command":' },
    });
  });

  it("refuses a delta of a kind its block does not take, which changes nothing", () => {
    const tool = { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } };
    const stream = reassemble(texted(tool, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "stray" } }), false);
    expect(notApplied(stream)).toEqual([["content_block_delta event", "text_delta does not extend content block 1, which takes input_json_delta"]]);
    expect(stream.reply!.blocks[1]).toMatchObject({ is: "arriving", arriving: { grows: { by: "input", input: "" } } });
  });

  it("refuses an event whose name is not its data's type", () => {
    const stream = reassemble(`${event(messageStart)}event: ping\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`, true);
    expect(notApplied(stream)).toEqual([["ping event", "its event is named ping, and its data's type is message_stop"]]);
    expect(stream.reply!.blocks).toEqual([]);
  });

  it("builds a reply from a message_start whose usage is null, and counts what message_delta reports", () => {
    const start = { ...messageStart, message: { ...messageStart.message, usage: null } };
    const stream = reassemble([start, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }].map((data) => event(data)).join(""), true);
    expect(stream.reply).toMatchObject({ stop: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    expect(stream.blocks).toEqual([]);
  });

  it("refuses a message_start whose usage is not counts, so nothing it sent is lost to a default", () => {
    const start = { ...messageStart, message: { ...messageStart.message, usage: "oops" } };
    const stream = reassemble(event(start), true);
    expect(notApplied(stream)).toEqual([["message_start event", "message: usage: is not an object"]]);
    expect(stream.reply).toBeUndefined();
  });

  it("keeps each event's fields no declaration reads by its path from the event's name, never on a field of what it builds, and a ping's on its event block", () => {
    const text = [
      messageStart,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" }, text: "X" },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hm.", estimated_tokens: 5 } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "..", estimated_tokens: 9 }, thinking: "stray" },
      { type: "content_block_stop", index: 0 },
      { type: "ping", sent: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", container: { id: "c" } }, usage: { service_tier: "standard" }, context_management: { applied_edits: [] } },
    ]
      .map((data) => event(data))
      .join("");
    const stream = reassemble(text, true);
    // A later event's field at a path replaces the earlier's, so a running estimate is one field, not one per delta.
    expect(stream.reply!.blocks).toEqual([
      {
        index: 0,
        is: "whole",
        block: { type: "thinking", thinking: "Hm..." },
        events: [
          { at: ["content_block_start", "text"], value: "X" },
          { at: ["content_block_delta", "delta", "estimated_tokens"], value: 9 },
          { at: ["content_block_delta", "thinking"], value: "stray" },
        ],
      },
    ]);
    expect(stream.reply!.unread.map(({ at, value }) => [at, value])).toEqual([
      [["id"], "msg_1"],
      [["role"], "assistant"],
      [["container"], { id: "c" }],
      [["usage", "service_tier"], "standard"],
    ]);
    expect(stream.reply!.events.map(({ at, value }) => [at, value])).toEqual([[["message_delta", "context_management"], { applied_edits: [] }]]);
    expect(stream.blocks).toEqual([{ category: "http", name: "ping event", parts: [{ id: "unread", label: "fields", kind: "rest", fields: [["sent", "1"]] }] }]);
  });

  it("refuses text that does not extend the text it reassembled", () => {
    const reassembly = createReassembly();
    reassembly.reassemble(stream("\n"), false);
    expect(() => reassembly.reassemble("", false)).toThrow(/a body only grows/);
  });
});
