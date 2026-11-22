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
    // The stop's field shows its event was applied: a stream's last event is applied once its text is complete. It is
    // the event's, shown beside the message it ends, not merged into it.
    expect(whole).toMatchObject({
      message: { content: [{ type: "text", text: "Hello, world." }, { type: "tool_use", input: { command: "ls" } }], stop_reason: "tool_use" },
      fields: [{ name: "message events", parts: [{ fields: [["message_stop", [["12", [["metrics", [["ms", "1"]]]]]]]] }] }],
      tail: "",
    });
    expect(whole.message).not.toHaveProperty("metrics");
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

  it("holds a tool's input as the text its deltas sent, its partial_json, until its block stops", () => {
    const text = stream("\n");
    const sofar = reassemble(text.slice(0, text.indexOf('"content_block_stop","index":1')), false);
    expect((sofar.message!.content as object[])[1]).toMatchObject({ input: {}, partial_json: '{"command": "ls"}' });
  });

  it("leaves the message's own fields to its start: a delta's others show as the event's fields", () => {
    const delta = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, type: "other", content: 5 }, usage: { output_tokens: 1 } };
    const { message, fields } = reassemble([messageStart, delta].map((data) => event(data)).join(""), true);
    expect(message).toMatchObject({ type: "message", content: [], stop_reason: "end_turn" });
    expect(fields).toMatchObject([{ name: "message events", parts: [{ fields: [["message_delta", [["1", [["delta", [["type", '"other"'], ["content", "5"]]]]]]]] }] }]);
  });

  const toolStart = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } };
  it.each([
    ["an event after the message stopped", [messageStart, { type: "message_stop" }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }], [], "content_block_start after message_stop"],
    ["a delta of another block type", [messageStart, toolStart, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }], [toolStart.content_block], "text_delta does not extend a tool_use block"],
  ])("does not apply %s, and says why", (_, events, content, why) => {
    const { message, blocks } = reassemble(events.map((data) => event(data)).join(""), true);
    expect(message!.content).toEqual(content);
    expect(blocks).toMatchObject([{ parts: [{ label: "not applied", text: why }, { id: "data" }] }]);
  });

  it("refuses text that does not extend the text it reassembled", () => {
    const reassembly = createReassembly();
    reassembly.reassemble(stream("\n"), false);
    expect(() => reassembly.reassemble("", false)).toThrow(/a body only grows/);
  });
});
