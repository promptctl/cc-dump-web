import { describe, expect, it } from "vitest";
import { contentOf } from "./blocks.ts";
import { soFar, type ReplyBlock } from "./reply.ts";
import { createReassembly, type Stream } from "./stream.ts";

// A stream's text reassembled all at once.
const reassemble = (text: string, complete: boolean) => createReassembly().reassemble(text, complete);

const event = (data: object, eol = "\n", name = (data as { type: string }).type) => `event: ${name}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
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

const blocksOf = (stream: Stream): readonly ReplyBlock[] => (stream.reply.at === "before" ? [] : stream.reply.reply.blocks);

describe("createReassembly", () => {
  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("reassembles a stream whose lines end in %s, fed in two pieces at every split, as it does whole", (_, eol) => {
    const text = stream(eol);
    const whole = reassemble(text, true);
    // The stop's field shows its event was applied: a stream's last event is applied once its text is complete.
    expect(whole.reply).toMatchObject({ at: "stopped", reply: { stop: { reason: "tool_use" }, events: [{ at: ["message_stop", "metrics"], value: { ms: 1 } }] } });
    expect(blocksOf(whole).map((block) => block.is === "whole" && block.block)).toEqual([
      contentOf({ type: "text", text: "Hello, world." }),
      contentOf({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }),
    ]);
    expect(whole).toMatchObject({ errors: [{ name: "error" }], blocks: [], tail: "" });
    for (let at = 0; at <= text.length; at++) {
      const reassembly = createReassembly();
      expect(reassembly.reassemble(text.slice(0, at), false), `split at ${at}`).toEqual(reassemble(text.slice(0, at), false));
      expect(reassembly.reassemble(text, true), `split at ${at}`).toEqual(whole);
    }
  });

  it("returns lists of its own each time, which later events do not change", () => {
    const reassembly = createReassembly();
    const text = stream("\n");
    const early = reassembly.reassemble(text.slice(0, text.indexOf('"error"')), false);
    const copy = structuredClone(early);
    reassembly.reassemble(text, true);
    expect(early).toEqual(copy);
  });

  it("holds a tool's input as its text until its block stops", () => {
    const text = stream("\n");
    const sofar = blocksOf(reassemble(text.slice(0, text.indexOf('"content_block_stop","index":1')), false))[1]!;
    expect(sofar.is === "arriving" && soFar(sofar)).toMatchObject({ input: '{"command": "ls"}' });
  });

  it("applies no event named otherwise than its type, or not named, which the Messages API never sends", () => {
    const named = reassemble(event(messageStart, "\n", "content_block_start") + `data: ${JSON.stringify(messageStart)}\n\n`, true);
    expect(named.reply).toEqual({ at: "before" });
    expect(named.blocks.map(({ name, parts }) => [name, parts[0]])).toEqual([
      ["content_block_start event", { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: "its type message_start is not its event's name" }],
      ["message event", { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: "its type message_start is not its event's name" }],
    ]);
  });

  it("shows a ping's fields and an event it cannot apply on their own, with why", () => {
    const shown = reassemble(event({ type: "ping", at: 1 }) + event({ type: "content_block_stop", index: 0 }) + event({ type: "sparkle" }), true);
    expect(shown.blocks.map(({ name, parts }) => [name, parts[0]])).toEqual([
      ["ping event", { kind: "rest", id: "unread", label: "fields", fields: [["at", "1"]] }],
      ["content_block_stop event", { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: "content_block_stop before message_start" }],
      ["sparkle event", expect.objectContaining({ id: "misfit", text: expect.stringMatching(/^type: is not one of /) })],
    ]);
  });

  it("refuses text that does not extend the text it reassembled", () => {
    const reassembly = createReassembly();
    reassembly.reassemble(stream("\n"), false);
    expect(() => reassembly.reassemble("", false)).toThrow(/a body only grows/);
  });
});
