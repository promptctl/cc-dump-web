import { fields, fromJsonText, held, entries, kinds, list, nullable, object, optional, raw, readShown, refusalOf, union, value, whole, type Fields, type Path, type Shown, type Tagged, type Unread } from "@cc-dump/log/json";
import { contentBlocks, contentOf, growsOf, type Content } from "./blocks.ts";

// A Messages reply as its stream of events builds it, or as a whole response returns it, one shape for both.

// [LAW:types-are-the-program] What a streamed block has grown by, from its start and its deltas, by what its type grows
// by (format/blocks.ts): its text and the citations of it, its thinking and its signature, or its tool input's JSON as
// far as it has streamed.
type Grown =
  | { by: "text"; text: string; citations: readonly unknown[] | null | undefined }
  | { by: "thinking"; thinking: string; signature: string | undefined }
  | { by: "input"; json: string }
  | { by: "nothing" };

// A field of an event no declaration names, at its path from the event, its event's name first. A later one at the same
// path replaces it.
export type EventField = { readonly at: Path; readonly value: unknown };

// A block of the reply, at its index: arriving, its start and what it has grown by; whole, read once it stopped; or
// refused, as its start read, since what it grew by does not make a block. `events`: the fields of its events no
// declaration names.
export type ReplyBlock = { readonly index: number; readonly events: readonly EventField[] } & (
  | { readonly is: "arriving"; readonly start: Readonly<Record<string, unknown>>; readonly grown: Grown }
  | { readonly is: "whole"; readonly block: Content }
  | { readonly is: "refused"; readonly why: string; readonly block: Content }
);

// The counts a reply's usage holds, each null where the API says none.
type UsageCounts = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
// A reply's usage: as sent, to show, each update's fields over those before; the counts that read, for the facts; and
// each usage that did not read, raw.
export type Usage = { readonly shown: Readonly<Record<string, unknown>> | null | undefined; readonly counts: Partial<UsageCounts>; readonly refused: readonly { why: string; sent: unknown }[] };
type Stop = { stop_reason?: string | null; stop_sequence?: string | null };
// [LAW:types-are-the-program] A reply: its blocks by index; why it stopped, null until the API says, undefined where it
// never does; its usage; the fields of its message no declaration names; and the fields of its events no declaration
// names, its blocks' events aside.
export type Reply = {
  readonly blocks: readonly ReplyBlock[];
  readonly stop: { readonly reason: string | null | undefined; readonly sequence: string | null | undefined };
  readonly usage: Usage;
  readonly unread: readonly Unread[];
  readonly events: readonly EventField[];
};
// A stream's reply: none before its message starts, then the reply its events have built, until its message stops.
export type State = { readonly at: "before" } | { readonly at: "started" | "stopped"; readonly reply: Reply };
export type Applied = { readonly is: "applied"; readonly state: State } | { readonly is: "refused"; readonly why: string };

const string = value(kinds.string);
const index = value(kinds.integer);
const counts = fields<UsageCounts>({
  input_tokens: optional(nullable(index)),
  output_tokens: optional(nullable(index)),
  cache_read_input_tokens: optional(nullable(index)),
  cache_creation_input_tokens: optional(nullable(index)),
});

// [LAW:one-source-of-truth] A message's fields, as a whole response returns it and as message_start begins it.
export type MessageFields = { content: readonly Content[]; usage?: Shown<Fields<UsageCounts> | null> } & Stop;
export const messageFields = {
  content: contentBlocks,
  stop_reason: optional(nullable(string)),
  stop_sequence: optional(nullable(string)),
  usage: optional(held(nullable(counts))),
};

type DeltaVariants = {
  text_delta: { text: string };
  citations_delta: { citation: unknown };
  thinking_delta: { thinking: string };
  signature_delta: { signature: string };
  input_json_delta: { partial_json: string };
};

// [LAW:types-are-the-program] The events of a Messages stream, each read by its type with no state. What a message or
// a message's delta holds is the message's, so each is held, named from itself; a block's delta is its event's.
type EventVariants = {
  message_start: { message: Shown<Tagged<{ message: MessageFields }>> };
  content_block_start: { index: number; content_block: Readonly<Record<string, unknown>> };
  content_block_delta: { index: number; delta: Tagged<DeltaVariants> };
  content_block_stop: { index: number };
  message_delta: { delta: Shown<Fields<Stop>>; usage: Shown<Fields<UsageCounts>> };
  message_stop: Record<never, never>;
  ping: Record<never, never>;
  error: { error: unknown };
};
export type Event = Tagged<EventVariants>;
export const event = fromJsonText(
  union<"type", EventVariants>("type", {
    message_start: { message: held(union<"type", { message: MessageFields }>("type", { message: messageFields })) },
    content_block_start: { index, content_block: entries(raw) },
    content_block_delta: {
      index,
      delta: union<"type", DeltaVariants>("type", {
        text_delta: { text: string },
        citations_delta: { citation: raw },
        thinking_delta: { thinking: string },
        signature_delta: { signature: string },
        input_json_delta: { partial_json: string },
      }),
    },
    content_block_stop: { index },
    message_delta: { delta: held(fields<Stop>({ stop_reason: optional(nullable(string)), stop_sequence: optional(nullable(string)) })), usage: held(counts) },
    message_stop: {},
    ping: {},
    error: { error: raw },
  }),
);

// A usage as it read: none, refused, null, or counts, of which those that do not read are refused, raw.
function usageOf(usage: Shown<Fields<UsageCounts> | null> | undefined): Usage {
  if (usage === undefined) return { shown: undefined, counts: {}, refused: [] };
  if (usage.is === "refused") return { shown: undefined, counts: {}, refused: [{ why: usage.why, sent: usage.sent }] };
  const read = usage.read.value;
  if (read === null) return { shown: null, counts: {}, refused: [] };
  return { shown: read.sent, counts: read.value, refused: read.refused.length === 0 ? [] : [{ why: refusalOf(read.refused, []), sent: read.sent }] };
}

// A whole message's reply: each block whole at its index.
export function wholeReply({ value, unread }: Fields<MessageFields>): Reply {
  return {
    blocks: (value.content ?? []).map((block, index): ReplyBlock => ({ index, events: [], is: "whole", block })),
    stop: { reason: value.stop_reason, sequence: value.stop_sequence },
    usage: usageOf(value.usage),
    unread,
    events: [],
  };
}

// `next` over `prior`, a field at the path or the key of one before it replacing it where it stands.
const samePath = (a: Path, b: Path) => a.length === b.length && a.every((name, at) => name === b[at]);
const over = <T,>(prior: readonly T[], next: readonly T[], same: (a: T, b: T) => boolean): readonly T[] =>
  next.reduce((all, one) => {
    const at = all.findIndex((before) => same(before, one));
    return at === -1 ? [...all, one] : all.with(at, one);
  }, prior);
const overEvents = (prior: readonly EventField[], next: readonly EventField[]) => over(prior, next, (a, b) => samePath(a.at, b.at));
const overUnread = (prior: readonly Unread[], next: readonly Unread[]) => over(prior, next, (a, b) => samePath([...a.of, a.key], [...b.of, b.key]));

// The fields of an event no declaration names, `unread` of it or of a part of it, as its fields.
const eventFields = (name: string, unread: readonly Unread[]): EventField[] => unread.map(({ of, key, value }) => ({ at: [name, ...of, key], value }));

// What a block's start begins it growing with: the growing fields its start carries, a streamed block's from nothing
// where its start carries none. A start whose growing field does not read does not begin a block.
const textStart = object<{ text?: string; citations?: readonly unknown[] | null }>({ text: optional(string), citations: optional(nullable(list(raw))) });
const thinkingStart = object<{ thinking?: string; signature?: string }>({ thinking: optional(string), signature: optional(string) });
function grownFrom(start: Readonly<Record<string, unknown>>): Shown<Grown> {
  const by = growsOf(start.type);
  const grown = (value: Grown): Shown<Grown> => ({ is: "read", read: { value, dropped: [], unread: [] } });
  switch (by) {
    case "text": {
      const read = readShown(textStart, start);
      return read.is === "refused" ? read : grown({ by, text: read.read.value.text ?? "", citations: read.read.value.citations });
    }
    case "thinking": {
      const read = readShown(thinkingStart, start);
      return read.is === "refused" ? read : grown({ by, thinking: read.read.value.thinking ?? "", signature: read.read.value.signature });
    }
    case "input":
      return grown({ by, json: "" });
    case "nothing":
      return grown({ by });
  }
}

// A delta, whole, grown into what its block has grown by: none where its block does not grow by what it carries.
function grownBy(grown: Grown, delta: Tagged<DeltaVariants>): Grown | undefined {
  switch (delta.tag) {
    case "text_delta":
      return grown.by === "text" ? { ...grown, text: grown.text + whole(delta.fields, []).text } : undefined;
    case "citations_delta":
      return grown.by === "text" ? { ...grown, citations: [...(grown.citations ?? []), whole(delta.fields, []).citation] } : undefined;
    case "thinking_delta":
      return grown.by === "thinking" ? { ...grown, thinking: grown.thinking + whole(delta.fields, []).thinking } : undefined;
    case "signature_delta":
      return grown.by === "thinking" ? { ...grown, signature: (grown.signature ?? "") + whole(delta.fields, []).signature } : undefined;
    case "input_json_delta":
      return grown.by === "input" ? { ...grown, json: grown.json + whole(delta.fields, []).partial_json } : undefined;
  }
}

// A block as far as it has arrived: its start, with what it grew by in place of its growing fields, its input as
// `input` makes the JSON that streamed of it. An input none of which streamed is its start's.
function joined(start: Readonly<Record<string, unknown>>, grown: Grown, input: (json: string) => unknown): Record<string, unknown> {
  switch (grown.by) {
    case "text":
      return { ...start, text: grown.text, ...(grown.citations === undefined ? {} : { citations: grown.citations }) };
    case "thinking":
      return { ...start, thinking: grown.thinking, ...(grown.signature === undefined ? {} : { signature: grown.signature }) };
    case "input":
      return grown.json === "" ? { ...start } : { ...start, input: input(grown.json) };
    case "nothing":
      return { ...start };
  }
}

// An arriving block as far as it has arrived, its input's JSON the text it is so far.
export const soFar = (block: Extract<ReplyBlock, { is: "arriving" }>): Record<string, unknown> => joined(block.start, block.grown, (json) => json);

// A block at its stop: its input whole, read as the block it makes. An input that is not JSON makes the block refused,
// shown as its start, so the message can still stop.
const json = fromJsonText(raw);
function stopped(block: Extract<ReplyBlock, { is: "arriving" }>, events: readonly EventField[]): ReplyBlock {
  const { index, start, grown } = block;
  const input = grown.by === "input" && grown.json !== "" ? readShown(json, grown.json) : undefined;
  if (input?.is === "refused") return { index, events, is: "refused", why: `input: ${input.why}`, block: contentOf(start) };
  return { index, events, is: "whole", block: contentOf(joined(start, grown, () => input?.read.value)) };
}

const refuse = (why: string): Applied => ({ is: "refused", why });
const applied = (state: State): Applied => ({ is: "applied", state });

// [LAW:single-enforcer] An event applied to a stream's reply, or why it cannot be: an event out of its order, a block's
// event at an index that is not arriving, a delta its block does not grow by, or one holding a field that does not
// read. A keep-alive and an error, which may come before the message starts, change nothing. An unchanged block is
// the same object in the state after.
export function apply(state: State, event: Event): Applied {
  if (event.fields.refused.length > 0) return refuse(refusalOf(event.fields.refused, []));
  if (state.at === "stopped") return refuse(`${event.tag} after message_stop`);
  if (event.tag === "ping" || event.tag === "error") return applied(state);
  if (event.tag === "message_start") {
    if (state.at === "started") return refuse("the message has already started");
    const { message } = whole(event.fields, []);
    if (message.is === "refused") return refuse(`message: ${message.why}`);
    const { fields } = message.read.value;
    if (fields.refused.length > 0) return refuse(`message: ${refusalOf(fields.refused, [])}`);
    return applied({ at: "started", reply: { ...wholeReply(fields), events: eventFields(event.tag, event.fields.unread) } });
  }
  if (state.at === "before") return refuse(`${event.tag} before message_start`);
  const { reply } = state;
  const at = (reply: Reply): Applied => applied({ at: "started", reply });
  switch (event.tag) {
    case "content_block_start": {
      const { index, content_block } = whole(event.fields, []);
      if (reply.blocks.some((block) => block.index === index)) return refuse(`content block ${index} has already started`);
      const grown = grownFrom(content_block);
      if (grown.is === "refused") return refuse(`content_block: ${grown.why}`);
      const added: ReplyBlock = { index, events: eventFields(event.tag, event.fields.unread), is: "arriving", start: content_block, grown: grown.read.value };
      return at({ ...reply, blocks: [...reply.blocks, added].sort((a, b) => a.index - b.index) });
    }
    case "content_block_delta":
    case "content_block_stop": {
      const { index } = whole(event.fields, []);
      const block = reply.blocks.find((one) => one.index === index);
      if (block === undefined) return refuse(`no content block ${index} has started`);
      if (block.is !== "arriving") return refuse(`content block ${index} has stopped`);
      const events = overEvents(block.events, eventFields(event.tag, event.fields.unread));
      const next = event.tag === "content_block_stop" ? stopped(block, events) : grownOn(block, events, whole(event.fields, []).delta);
      return typeof next === "string" ? refuse(next) : at({ ...reply, blocks: reply.blocks.map((one) => (one === block ? next : one)) });
    }
    case "message_delta": {
      const { delta, usage } = whole(event.fields, []);
      if (delta.is === "refused") return refuse(`delta: ${delta.why}`);
      const stop = delta.read.value;
      if (stop.refused.length > 0) return refuse(`delta: ${refusalOf(stop.refused, [])}`);
      // Its counts replace those before, count by count.
      const added = usageOf(usage);
      return at({
        ...reply,
        stop: { reason: Object.hasOwn(stop.value, "stop_reason") ? stop.value.stop_reason : reply.stop.reason, sequence: Object.hasOwn(stop.value, "stop_sequence") ? stop.value.stop_sequence : reply.stop.sequence },
        usage: { shown: added.shown === undefined ? reply.usage.shown : { ...reply.usage.shown, ...added.shown }, counts: { ...reply.usage.counts, ...added.counts }, refused: [...reply.usage.refused, ...added.refused] },
        unread: overUnread(reply.unread, stop.unread),
        events: overEvents(reply.events, eventFields(event.tag, event.fields.unread)),
      });
    }
    case "message_stop": {
      const arriving = reply.blocks.find((block) => block.is === "arriving");
      if (arriving !== undefined) return refuse(`content block ${arriving.index} is still arriving`);
      return applied({ at: "stopped", reply: { ...reply, events: overEvents(reply.events, eventFields(event.tag, event.fields.unread)) } });
    }
  }
}

// An arriving block grown by a delta, its fields that no declaration names among its events, or why it is not.
function grownOn(block: Extract<ReplyBlock, { is: "arriving" }>, events: readonly EventField[], delta: Tagged<DeltaVariants>): ReplyBlock | string {
  if (delta.fields.refused.length > 0) return refusalOf(delta.fields.refused, []);
  const grown = grownBy(block.grown, delta);
  if (grown === undefined) return `content block ${block.index} does not take ${delta.tag}`;
  return { ...block, events: overEvents(events, eventFields("content_block_delta", delta.fields.unread)), grown };
}
