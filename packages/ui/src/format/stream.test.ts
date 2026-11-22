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
      message: { content: [{ type: "text", text: "Hello, world." }, { type: "tool_use", input: { command: "ls" } }], stop_reason: "tool_use" },
      blocks: [],
      unread: [{ at: ["message_stop", "0", "metrics"], value: { ms: 1 } }],
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

  it("shows a tool's input as its text until its block stops", () => {
    const text = stream("\n");
    const sofar = reassemble(text.slice(0, text.indexOf('"content_block_stop","index":1')), false);
    expect((sofar.message!.content as object[])[1]).toEqual({ type: "tool_use", id: "toolu_1", name: "Bash", partial_json: '{"command": "ls"}' });
  });

  // The reasons the events of `events` after message_start were not applied, and the stream they built.
  const notApplied = (...events: object[]) => {
    const built = reassemble([messageStart, ...events].map((data) => event(data)).join(""), true);
    return { reasons: built.blocks.map(({ parts }) => (parts[0] as { text: string }).text), built };
  };

  it("applies an event whole or not at all, saying why it did not", () => {
    const start = { type: "content_block_start", index: 0, content_block: { type: "text", text: "a" } };
    const { reasons, built } = notApplied(
      start,
      // A delta that extends a field of another block type, and one whose field does not read, change nothing.
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 5 } },
      { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { cited_text: "c" } } },
      { type: "content_block_delta", index: 0.5, delta: { type: "text_delta", text: "b" } },
      { type: "message_delta", delta: { stop_reason: 5 }, usage: {} },
      { type: "message_stop" },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } },
      { type: "message_stop" },
    );
    expect(reasons).toEqual([
      "thinking_delta does not extend a text block",
      "delta: text: is not a string",
      "index: is not an integer",
      "delta: stop_reason: is not a string",
      "content_block_delta after message_stop",
      "message_stop after message_stop",
    ]);
    expect(built.message).toMatchObject({ content: [{ type: "text", text: "a", citations: [{ cited_text: "c" }] }], stop_reason: null });
  });

  it("keeps the fields of every event no read asks for, a key `__proto__` among them, under the event's type and its place among those of its type", () => {
    const { built } = notApplied(
      { type: "ping" },
      JSON.parse('{"type": "ping", "__proto__": {"polluted": true}}'),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" }, at: 1 },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a", estimated_tokens: 3 } },
    );
    expect(built.unread.map(({ at, value }) => [at, value])).toEqual([
      [["ping", "1", "__proto__"], { polluted: true }],
      [["content_block_start", "0", "at"], 1],
      [["content_block_delta", "0", "delta", "estimated_tokens"], 3],
    ]);
    expect(({} as { polluted?: true }).polluted).toBeUndefined();
  });

  it("refuses text that does not extend the text it reassembled", () => {
    const reassembly = createReassembly();
    reassembly.reassemble(stream("\n"), false);
    expect(() => reassembly.reassemble("", false)).toThrow(/a body only grows/);
  });
});
