import { fromJsonText, kinds, object, raw as asSent, readShown, string, tagged, value, type Path } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, growsOf, restBlock, type Block } from "./blocks.ts";
import { messageFields, replyOf, sentSoFar, stopFields, updated, usage, type Arriving, type Grows, type Message, type Reply, type ReplyBlock, type Stop, type UnreadField, type Usage } from "./reply.ts";

// A streamed Messages response, reassembled: the reply as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, the blocks of its other
// events, each one this view did not apply and each keep-alive's fields it does not read, and the text after the last
// complete event, which is the next event still arriving or what a cut-off stream left.
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
// [LAW:types-are-the-program] The events of a Messages stream, each read on its own, with no state: what it means after
// the events before it is `apply`'s. A content block's start is the block as sent, which its type's entry reads
// (`growsOf`); a message_delta's `delta` and `usage` are the message's own fields, updated.
type Event =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: Record<string, unknown> }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: Stop; usage: Usage }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: unknown };

const index = value(kinds.integer);
const eventRead = fromJsonText(
  tagged<"type", Event>("type", {
    // Its message read as a whole response's is, so both leave the same fields to show.
    message_start: { message: tagged<"type", Message>("type", { message: messageFields }) },
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
    message_delta: { delta: object(stopFields), usage },
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

// What an event applied did: the state it leads to, the errors it returned, and its fields shown on its own block, a
// keep-alive's, which builds nothing to hold them; or why it does not follow the events before it, which changes
// nothing.
type Applied = { is: "applied"; state: State; errors: Block[]; own: readonly UnreadField[] } | { is: "refused"; why: string };
const refused = (why: string): Applied => ({ is: "refused", why });

// [LAW:no-silent-failure] An event's fields no declaration reads, each by its path from the event's name, so a field of
// one event is never another's, and none is ever a field of what the event builds. The fields of the message an event
// carries, a message_start's `message` and a message_delta's `delta` and `usage`, are the message's own, at their path in
// it, and the rest are the event's. `sent`: each at its path in the event, for an event that builds a block of its own.
type Split = { message: UnreadField[]; event: UnreadField[]; sent: readonly UnreadField[] };
function split(event: Event, unread: readonly UnreadField[]): Split {
  const own = (at: Path): Path | undefined => {
    if (event.type === "message_start" && at[0] === "message") return at.slice(1);
    if (event.type === "message_delta" && at[0] === "delta") return at.slice(1);
    return event.type === "message_delta" && at[0] === "usage" ? at : undefined;
  };
  const sorted = unread.map(({ at, value }) => ({ at, value, own: own(at) }));
  return {
    message: sorted.flatMap(({ value, own }) => (own === undefined ? [] : [{ at: own, value }])),
    event: sorted.flatMap(({ at, value, own }) => (own === undefined ? [{ at: [event.type, ...at], value }] : [])),
    sent: sorted.map(({ at, value }) => ({ at, value })),
  };
}

// [LAW:no-ambient-temporal-coupling] An event after the events before it: the state it leads to, or why it does not
// follow them.
function apply(state: State, event: Event, unread: Split): Applied {
  const built = (reply: Building): Applied => ({ is: "applied", state: { is: "started", reply }, errors: [], own: [] });
  switch (event.type) {
    case "ping":
      return { is: "applied", state, errors: [], own: unread.sent };
    case "message_start": {
      if (state.is !== "before") return refused("the message has already started");
      const { blocks, ...reply } = replyOf(event.message, unread.message);
      return built({ ...reply, events: unread.event, blocks: new Map(blocks.map((block) => [block.index, block])) });
    }
    case "error":
      return state.is === "stopped" ? refused("the message has stopped") : { is: "applied", state, errors: [formatError(event.error, unread.sent)], own: [] };
  }
  if (state.is !== "started") return refused(state.is === "before" ? `${event.type} before message_start` : "the message has stopped");
  const { reply } = state;
  switch (event.type) {
    case "content_block_start": {
      if (reply.blocks.has(event.index)) return refused(`content block ${event.index} has already started`);
      const arriving: Arriving = { start: event.content_block, grows: growsOf(event.content_block) };
      return built({ ...reply, blocks: new Map(reply.blocks).set(event.index, { index: event.index, events: unread.event, is: "arriving", arriving }) });
    }
    case "content_block_delta":
    case "content_block_stop": {
      const target = reply.blocks.get(event.index);
      if (target === undefined) return refused(`no content block ${event.index} has started`);
      if (target.is !== "arriving") return refused(`content block ${event.index} has stopped`);
      const events = updated(target.events, unread.event);
      if (event.type === "content_block_stop") return built({ ...reply, blocks: new Map(reply.blocks).set(event.index, { ...stopped(target.arriving), index: event.index, events }) });
      const grows = extended(target.arriving.grows, event.delta);
      if (grows === undefined) return refused(`${event.delta.type} does not extend content block ${event.index}, which takes ${takes[target.arriving.grows.by]}`);
      return built({ ...reply, blocks: new Map(reply.blocks).set(event.index, { ...target, events, arriving: { ...target.arriving, grows } }) });
    }
    // The counts so far, each replacing the one before.
    case "message_delta":
      return built({ ...reply, stop: { ...reply.stop, ...event.delta }, usage: { ...reply.usage, ...event.usage }, unread: updated(reply.unread, unread.message), events: updated(reply.events, unread.event) });
    case "message_stop": {
      const arriving = [...reply.blocks.values()].find((block) => block.is === "arriving");
      if (arriving !== undefined) return refused(`content block ${arriving.index} is still arriving`);
      return { is: "applied", state: { is: "stopped", reply: { ...reply, events: updated(reply.events, unread.event) } }, errors: [], own: [] };
    }
  }
}

// [LAW:types-are-the-program] What a block's deltas grow, extended by a delta of the kind its type takes, or none for a
// delta of another kind. A field a delta extends starts from nothing when the block's start did not send it.
function extended(grows: Grows, delta: Delta): Grows | undefined {
  switch (delta.type) {
    case "text_delta":
      return grows.by === "text" ? { ...grows, text: grows.text + delta.text } : undefined;
    case "citations_delta":
      return grows.by === "text" ? { ...grows, citations: [...(grows.citations ?? []), delta.citation] } : undefined;
    case "thinking_delta":
      return grows.by === "thinking" ? { ...grows, thinking: grows.thinking + delta.thinking } : undefined;
    case "signature_delta":
      return grows.by === "thinking" ? { ...grows, signature: (grows.signature ?? "") + delta.signature } : undefined;
    case "input_json_delta":
      return grows.by === "input" ? { ...grows, input: grows.input + delta.partial_json } : undefined;
  }
}
// The deltas a block takes, by what they grow, in a refusal's words.
const takes: Record<Grows["by"], string> = {
  text: "text_delta and citations_delta",
  thinking: "thinking_delta and signature_delta",
  input: "input_json_delta",
  nothing: "no delta",
};

// A block at its stop: its start's block with what its deltas grew, its tool input the JSON its deltas sent, where
// they sent any, or the input its start sent, as the Messages API streams an empty input. [LAW:no-silent-failure] One
// whose input is not JSON is a block refused, with why, which still stops, so its reply can.
function stopped(arriving: Arriving): { is: "whole"; block: unknown } | { is: "refused"; why: string; block: unknown } {
  const block = sentSoFar(arriving);
  const { grows } = arriving;
  if (grows.by !== "input" || grows.input === "") return { is: "whole", block };
  const input = readShown(fromJsonText(asSent), grows.input);
  return input.is === "read" ? { is: "whole", block: { ...block, input: input.read.value } } : { is: "refused", why: `its streamed input ${input.why}`, block: { ...block, input: grows.input } };
}

// What one event of the SSE event `name` does to the stream after `state`: the state it leads to and the blocks it
// adds. [LAW:no-silent-failure] An event that does not read, names another type than its data's, or does not follow the
// events before it, is shown raw under its event name, with why, and changes nothing; a keep-alive's fields, which
// build nothing, are shown on its block.
function stepped(state: State, name: string, data: string): { state: State; errors: Block[]; blocks: Block[] } {
  const read = readShown(eventRead, data);
  const applied: Applied =
    read.is === "refused"
      ? refused(read.why)
      : read.read.value.type !== name
        ? refused(`its event is named ${name}, and its data's type is ${read.read.value.type}`)
        : apply(state, read.read.value, split(read.read.value, read.read.unread));
  if (applied.is === "refused") {
    const notApplied: Block = {
      category: "http",
      name: `${name} event`,
      parts: [
        { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: applied.why },
        { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
      ],
    };
    return { state, errors: [], blocks: [notApplied] };
  }
  return { state: applied.state, errors: applied.errors, blocks: restBlock(applied.own, "http", `${name} event`) };
}

// The reply a stream has built, its blocks by their index.
const replyIn = (state: State): Reply | undefined =>
  state.is === "before" ? undefined : { ...state.reply, blocks: [...state.reply.blocks.values()].sort((a, b) => a.index - b.index) };

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
