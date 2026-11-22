import { fields, readShown } from "@cc-dump/log/json";
import { describe, expect, it } from "vitest";
import { contentOf } from "./blocks.ts";
import { apply, event, messageFields, soFar, wholeReply, type Applied, type MessageFields, type ReplyBlock, type State } from "./reply.ts";

// An event as the stream's data carries it, read.
function read(data: object) {
  const shown = readShown(event, JSON.stringify(data));
  if (shown.is === "refused") throw new Error(shown.why);
  return shown.read.value;
}
// Each event applied in turn to the state the one before it left, from before the message: each outcome.
function outcomes(events: object[]): Applied[] {
  let state: State = { at: "before" };
  return events.map((data) => {
    const outcome = apply(state, read(data));
    if (outcome.is === "applied") state = outcome.state;
    return outcome;
  });
}
// The state a stream every event of which applies leaves.
function played(events: object[]): State {
  const all = outcomes(events);
  expect(all.filter(({ is }) => is === "refused")).toEqual([]);
  return (all.at(-1) as Extract<Applied, { is: "applied" }>).state;
}
const replyOf = (state: State) => (state.at === "before" ? undefined : state.reply);
const refusals = (events: object[]) => outcomes(events).flatMap((outcome) => (outcome.is === "refused" ? [outcome.why] : []));

const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-2", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } };
const start = { type: "message_start", message };
const blockStart = (index: number, content_block: object) => ({ type: "content_block_start", index, content_block });
const delta = (index: number, delta: object) => ({ type: "content_block_delta", index, delta });
const stop = (index: number) => ({ type: "content_block_stop", index });
const messageDelta = { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 90 }, context_management: { applied_edits: [] } };
// A stream as the Messages API sends one: thinking, a text, and a tool's call whose input streams in pieces.
const stream = [
  start,
  blockStart(0, { type: "thinking", thinking: "", signature: "" }),
  { type: "ping" },
  delta(0, { type: "thinking_delta", thinking: "", estimated_tokens: 50 }),
  delta(0, { type: "signature_delta", signature: "c2ln" }),
  stop(0),
  blockStart(1, { type: "text", text: "" }),
  delta(1, { type: "text_delta", text: "Red and " }),
  delta(1, { type: "text_delta", text: "blue." }),
  stop(1),
  blockStart(2, { type: "tool_use", id: "toolu_2", name: "Bash", input: {} }),
  delta(2, { type: "input_json_delta", partial_json: '{"command":' }),
  delta(2, { type: "input_json_delta", partial_json: '"ls"}' }),
  stop(2),
  messageDelta,
  { type: "message_stop", metrics: { ms: 1 } },
];
const content = [
  { type: "thinking", thinking: "", signature: "c2ln" },
  { type: "text", text: "Red and blue." },
  { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
];

describe("a reply", () => {
  it("is built by a stream's events as a whole response returns it, each event's own fields kept as its", () => {
    const streamed = played(stream);
    expect(streamed.at).toBe("stopped");
    const reply = replyOf(streamed)!;
    expect(reply.blocks).toEqual(content.map((block, index) => ({ index, events: index === 0 ? [{ at: ["content_block_delta", "delta", "estimated_tokens"], value: 50 }] : [], is: "whole", block: contentOf(block) })));
    expect(reply.stop).toEqual({ reason: "tool_use", sequence: null });
    // The delta's counts replace those before, count by count.
    expect(reply.usage).toEqual({ shown: { input_tokens: 2, output_tokens: 90 }, counts: { input_tokens: 2, output_tokens: 90 }, refused: [] });
    expect(reply.unread.map(({ key }) => key)).toEqual(["id", "role", "model"]);
    expect(reply.events).toEqual([
      { at: ["message_delta", "context_management"], value: { applied_edits: [] } },
      { at: ["message_stop", "metrics"], value: { ms: 1 } },
    ]);

    const response = readShown(fields<MessageFields>(messageFields), { ...message, content, stop_reason: "tool_use", usage: { input_tokens: 2, output_tokens: 90 } });
    expect(response.is === "read" && wholeReply(response.read.value).blocks.map(({ is, index, ...rest }) => [index, is, "block" in rest ? rest.block : undefined])).toEqual(
      content.map((block, index) => [index, "whole", contentOf(block)]),
    );
  });

  it("shows a block arriving as far as it has: its text so far, its input the JSON text that streamed", () => {
    const arriving = (events: object[], index: number) => replyOf(played(events))!.blocks.find((block) => block.index === index) as Extract<ReplyBlock, { is: "arriving" }>;
    expect(soFar(arriving(stream.slice(0, 8), 1))).toEqual({ type: "text", text: "Red and " });
    expect(soFar(arriving(stream.slice(0, 12), 2))).toEqual({ type: "tool_use", id: "toolu_2", name: "Bash", input: '{"command":' });
    // An input none of which streamed is its start's, and a citation grows its text's citations.
    expect(soFar(arriving(stream.slice(0, 11), 2))).toEqual({ type: "tool_use", id: "toolu_2", name: "Bash", input: {} });
    const cited = [start, blockStart(0, { type: "text", text: "", citations: null }), delta(0, { type: "citations_delta", citation: { cited_text: "Red" } })];
    expect(soFar(arriving(cited, 0))).toEqual({ type: "text", text: "", citations: [{ cited_text: "Red" }] });
  });

  it("keeps a block no event changed the same object in the state after", () => {
    const state = played(stream.slice(0, 7));
    const after = [stream[7]!, stream[8]!].reduce((on, data) => (apply(on, read(data)) as Extract<Applied, { is: "applied" }>).state, state);
    expect(replyOf(after)!.blocks[0]).toBe(replyOf(state)!.blocks[0]);
    expect(replyOf(after)!.blocks[1]).not.toBe(replyOf(state)!.blocks[1]);
  });

  it("refuses an event out of its order, at an index not arriving, of a kind its block does not take, or holding a field that does not read", () => {
    const text = blockStart(0, { type: "text", text: "" });
    expect(refusals([{ type: "ping" }, { type: "error", error: {} }, stop(0)])).toEqual(["content_block_stop before message_start"]);
    expect(refusals([start, start])).toEqual(["the message has already started"]);
    expect(refusals([start, text, text])).toEqual(["content block 0 has already started"]);
    expect(refusals([start, delta(1, { type: "text_delta", text: "a" }), stop(1)])).toEqual(["no content block 1 has started", "no content block 1 has started"]);
    expect(refusals([start, text, stop(0), delta(0, { type: "text_delta", text: "a" }), stop(0)])).toEqual(["content block 0 has stopped", "content block 0 has stopped"]);
    expect(refusals([start, text, delta(0, { type: "input_json_delta", partial_json: "{" })])).toEqual(["content block 0 does not take input_json_delta"]);
    expect(refusals([start, blockStart(0, { type: "redacted_thinking", data: "x" }), delta(0, { type: "text_delta", text: "a" })])).toEqual(["content block 0 does not take text_delta"]);
    expect(refusals([start, text, { type: "message_stop" }])).toEqual(["content block 0 is still arriving"]);
    expect(refusals([start, { type: "message_stop" }, { type: "ping" }])).toEqual(["ping after message_stop"]);
    expect(refusals([start, text, delta(0, { type: "text_delta", text: 7 }), { type: "content_block_delta", delta: { type: "text_delta", text: "a" } }])).toEqual(["delta: text: is not a string", "index: is missing"]);
    expect(refusals([{ ...start, message: { ...message, content: 7 } }, { type: "message_start", message: { type: "error" } }])).toEqual([
      "message: content: is not a list",
      "message: type: is not one of message",
    ]);
    expect(refusals([start, blockStart(0, { type: "text", text: 7 }), { type: "message_delta", delta: { stop_reason: 7 }, usage: {} }])).toEqual([
      "content_block: text: is not a string",
      "delta: stop_reason: is not a string",
    ]);
    expect(() => read({ type: "sparkle" })).toThrow("type: is not one of message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop, ping, error");
  });

  it("refuses at its stop a block whose input is not JSON, as its start, so the message can still stop", () => {
    const state = played([start, blockStart(0, { type: "tool_use", id: "t", name: "Bash", input: {} }), delta(0, { type: "input_json_delta", partial_json: '{"command": "l' }), stop(0), { type: "message_stop" }]);
    expect(replyOf(state)!.blocks).toEqual([
      { index: 0, events: [], is: "refused", why: expect.stringMatching(/^input: is not JSON: /), block: contentOf({ type: "tool_use", id: "t", name: "Bash", input: {} }) },
    ]);
  });

  it("keeps a later event's field at the same path in place of the one before, and each usage that does not read, raw", () => {
    const reply = replyOf(played([{ ...start, message: { ...message, usage: { input_tokens: "2" } } }, { ...messageDelta, context_management: 1 }, { ...messageDelta, context_management: 2, usage: null }]))!;
    expect(reply.events).toEqual([{ at: ["message_delta", "context_management"], value: 2 }]);
    expect(reply.usage).toEqual({
      shown: { input_tokens: "2", output_tokens: 90 },
      counts: { output_tokens: 90 },
      refused: [
        { why: "input_tokens: is not an integer", sent: { input_tokens: "2" } },
        { why: "is not an object", sent: null },
      ],
    });
  });
});
