import { fromJsonText, kinds, object, optional, raw as asSent, readShown, tagged, value } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, restBlock, type Block } from "./blocks.ts";
import { fieldsOf, messageFields, replyOf, type Message, type Reply, type ReplyBlock, type Stop, type UnreadField } from "./reply.ts";

// A streamed Messages response, reassembled: the reply as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, the blocks of its other
// events, each one this view did not apply and each one's fields it does not read, and the text after the last complete
// event, which is the next event still arriving or what a cut-off stream left.
export type Stream = { reply: Reply | undefined; errors: Block[]; blocks: Block[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied
// before are not read or applied again, so a response read while it streams costs the text it receives, not its whole
// length each time. [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only
// grows, so each call's text begins with the text before, and the stream equals a reassembly of all of it at once.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// [LAW:types-are-the-program] A content block delta: the text a block's field gains, its tool input's next JSON text, or
// a citation.
type Delta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "citations_delta"; citation: unknown };
// The events of a Messages stream, each read on its own, with no state: what it means after the events before it is
// `apply`'s.
type Event =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: Record<string, unknown> }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: Stop; usage: Record<string, unknown> }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: unknown };

const string = value(kinds.string);
const index = value(kinds.integer);
const eventRead = fromJsonText(
  tagged<"type", Event>("type", {
    // Its message's type read as a whole response's is, so both leave the same fields to show.
    message_start: { message: tagged<"type", { type: "message" } & Message>("type", { message: messageFields }) },
    content_block_start: { index, content_block: value(kinds.object) },
    content_block_delta: {
      index,
      delta: tagged<"type", Delta>("type", {
        text_delta: { text: string },
        thinking_delta: { thinking: string },
        signature_delta: { signature: string },
        input_json_delta: { partial_json: string },
        citations_delta: { citation: asSent },
      }),
    },
    content_block_stop: { index },
    message_delta: { delta: object<Stop>({ stop_reason: optional(asSent), stop_sequence: optional(asSent) }), usage: value(kinds.object) },
    message_stop: {},
    // A keep-alive, which may come at any time and builds nothing.
    ping: {},
    error: { error: asSent },
  }),
);

// [LAW:types-are-the-program] A stream's state: before its message starts, while it builds, and once it has stopped,
// after which only a keep-alive may come. A reply being built holds its blocks by their index.
type Building = Omit<Reply, "blocks"> & { blocks: ReadonlyMap<number, ReplyBlock> };
type State = { is: "before" } | { is: "started"; reply: Building } | { is: "stopped"; reply: Building };

// What an event applied did: the state it leads to, the errors it returned, and its fields that land on nothing it
// builds, which its event's block shows.
type Applied = { state: State; errors: Block[]; unread: readonly UnreadField[] };
type Refused = { refused: string };

// [LAW:no-silent-failure] The fields an event carries that no declaration reads, as fields of what it builds, the
// message or a content block, where they are shown: one under the event's `part`, its message or its delta, as a field
// of that part, and each of the event's own.
const lifted = (unread: readonly UnreadField[], part: string): UnreadField[] => unread.map((field) => (field.at[0] === part ? { ...field, at: field.at.slice(1) } : field));

// [LAW:one-source-of-truth] A message's fields with each of `updates` set: one it held keeps its place, one it did not
// follows, as each event after message_start updates the message it began.
const updated = (fields: readonly UnreadField[], updates: readonly UnreadField[]): UnreadField[] => {
  const named = (field: UnreadField) => field.at.join(".");
  const kept = fields.map((field) => updates.find((update) => named(update) === named(field)) ?? field);
  return [...kept, ...updates.filter((update) => !fields.some((field) => named(field) === named(update)))];
};

// [LAW:no-ambient-temporal-coupling] An event after the events before it: the state it leads to, or why it does not
// follow them, which changes nothing.
function apply(state: State, event: Event, unread: readonly UnreadField[]): Applied | Refused {
  const built = (reply: Building): Applied => ({ state: { is: "started", reply }, errors: [], unread: [] });
  switch (event.type) {
    // A keep-alive builds nothing, so the fields it carries are shown on its own.
    case "ping":
      return { state, errors: [], unread };
    case "message_start": {
      if (state.is !== "before") return { refused: "the message has already started" };
      const { blocks, ...reply } = replyOf(event.message, lifted(unread, "message"));
      return built({ ...reply, blocks: new Map(blocks.map((block, at) => [at, block])) });
    }
    case "error":
      return state.is === "stopped" ? { refused: "the message has stopped" } : { state, errors: [formatError(event.error, unread)], unread: [] };
  }
  if (state.is !== "started") return { refused: state.is === "before" ? `${event.type} before message_start` : "the message has stopped" };
  const { reply } = state;
  switch (event.type) {
    case "content_block_start":
      if (reply.blocks.has(event.index)) return { refused: `content block ${event.index} has already started` };
      return built({ ...reply, blocks: new Map(reply.blocks).set(event.index, { is: "arriving", block: { ...event.content_block, ...fieldsOf(unread) }, input: "" }) });
    case "content_block_delta":
    case "content_block_stop": {
      const target = reply.blocks.get(event.index);
      if (target === undefined) return { refused: `no content block ${event.index} has started` };
      if (target.is === "whole") return { refused: `content block ${event.index} has stopped` };
      const carrying = { ...target, block: { ...target.block, ...fieldsOf(lifted(unread, "delta")) } };
      const next = event.type === "content_block_delta" ? extended(carrying, event.delta) : stopped(carrying);
      return "refused" in next ? next : built({ ...reply, blocks: new Map(reply.blocks).set(event.index, next) });
    }
    case "message_delta": {
      const usage = { ...(kinds.object.fits(reply.usage) ? reply.usage : {}), ...event.usage };
      return built({ ...reply, ...event.delta, usage, unread: updated(reply.unread, lifted(unread, "delta")) });
    }
    case "message_stop": {
      const arriving = [...reply.blocks].find(([, block]) => block.is === "arriving");
      return arriving === undefined ? { state: { is: "stopped", reply: { ...reply, unread: updated(reply.unread, unread) } }, errors: [], unread: [] } : { refused: `content block ${arriving[0]} is still arriving` };
    }
  }
}

// A block still arriving, extended by a delta: a field a delta extends starts from nothing when the block's start did
// not carry it.
function extended(arriving: Extract<ReplyBlock, { is: "arriving" }>, delta: Delta): ReplyBlock | Refused {
  const append = (field: string, text: string): ReplyBlock | Refused => {
    const prior = arriving.block[field] ?? "";
    return typeof prior === "string" ? { ...arriving, block: { ...arriving.block, [field]: prior + text } } : { refused: `${delta.type} extends a block whose ${field} is not a string` };
  };
  switch (delta.type) {
    case "text_delta":
      return append("text", delta.text);
    case "thinking_delta":
      return append("thinking", delta.thinking);
    case "signature_delta":
      return append("signature", delta.signature);
    case "input_json_delta":
      return { ...arriving, input: arriving.input + delta.partial_json };
    case "citations_delta": {
      const prior = arriving.block.citations ?? [];
      return Array.isArray(prior) ? { ...arriving, block: { ...arriving.block, citations: [...prior, delta.citation] } } : { refused: "citations_delta extends a block whose citations are not a list" };
    }
  }
}

// A block at its stop, whole: its start's block and its deltas, its tool input, where any was sent, the JSON it now is.
function stopped({ block, input }: Extract<ReplyBlock, { is: "arriving" }>): ReplyBlock | Refused {
  if (input === "") return { is: "whole", block };
  const read = readShown(fromJsonText(asSent), input);
  return "refused" in read ? { refused: `the block's streamed input ${read.refused}` } : { is: "whole", block: { ...block, input: read.value } };
}

// What one event of the SSE event `name` does to the stream after `state`: the state it leads to and the blocks it
// adds. [LAW:no-silent-failure] An event that does not read, or does not follow the events before it, is shown raw
// under its event name, with why, and changes nothing; an event's fields that build nothing are shown on its block.
function stepped(state: State, name: string, data: string): { state: State; errors: Block[]; blocks: Block[] } {
  const read = readShown(eventRead, data);
  const applied = "refused" in read ? read : apply(state, read.value, read.unread);
  if ("refused" in applied) {
    const notApplied: Block = {
      category: "http",
      name: `${name} event`,
      parts: [
        { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: applied.refused },
        { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
      ],
    };
    return { state, errors: [], blocks: [notApplied] };
  }
  return { state: applied.state, errors: applied.errors, blocks: restBlock(applied.unread, "http", `${name} event`) };
}

// The reply a stream has built, its blocks by their index.
const replyIn = (state: State): Reply | undefined =>
  state.is === "before" ? undefined : { ...state.reply, blocks: [...state.reply.blocks].sort(([a], [b]) => a - b).map(([, block]) => block) };

export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let state: State = { is: "before" };
  const errors: Block[] = [];
  const blocks: Block[] = [];
  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event, data } of events) {
        const next = stepped(state, event, data);
        state = next.state;
        errors.push(...next.errors);
        blocks.push(...next.blocks);
      }
      return { reply: replyIn(state), errors: [...errors], blocks: [...blocks], tail };
    },
  };
}
