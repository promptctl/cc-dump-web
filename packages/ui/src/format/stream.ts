import { Malformed } from "@cc-dump/log/failure";
import {
  attempt,
  holding,
  kinds,
  mapped,
  nullable,
  object,
  optional,
  orElse,
  parseJson,
  raw,
  taggedFields,
  value,
  worded,
  type Read,
  type Reader,
  type Refusal,
} from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { apiError, formatError, unreadParts, type Block } from "./blocks.ts";
import { doesNotFit, type Part } from "./parts.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, a block for each event
// this view did not apply, or applied without a field of it, or that holds fields no read asked for, and the text after
// the last complete event, which is the next event still arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; errors: Block[]; blocks: Block[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied
// before are not parsed or applied again, so a response read while it streams costs the text it receives, not its whole
// length each time.
// [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only grows, so each
// call's text begins with the text before, and the stream equals a reassembly of all of it at once. Each call returns
// objects of its own, so a stream already returned is never changed by an event after it.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// [LAW:types-are-the-program] Where the message stands: not begun, before message_start; being built by its events; or
// stopped, at message_stop. Only a message that has begun has fields, a usage and content: its usage apart from its
// other fields, as its events bring counts to merge into it, and none where none was brought.
type Usage = Record<string, unknown> | null | undefined;
type Message = { fields: Record<string, unknown>; usage: Usage; content: ReadonlyMap<number, Building> };
type Phase = { is: "before" } | { is: "building"; message: Message } | { is: "stopped"; message: Message };
// The reassembly so far: where the message stands, and the errors the stream's error events returned.
type State = { phase: Phase; errors: readonly Block[] };

// A content block being built from its events: its type; the fields its start sent that no delta extends; the fields
// its deltas extend, a text, a thinking and its signature, or the citations of a text; its tool input, while its
// deltas stream it, the JSON so far; and whether it has stopped.
type Extended = { text: string | undefined; thinking: string | undefined; signature: string | undefined; citations: unknown[] | undefined };
const unextended: Extended = { text: undefined, thinking: undefined, signature: undefined, citations: undefined };
// A tool's input streams from its block's start, which holds the input it sent apart, `start`, until its stop.
type Streamed = { is: "sent" } | { is: "streaming"; start: Record<string, unknown>; json: string };
type Building = { type: string; others: Record<string, unknown>; extended: Extended; input: Streamed; stopped: boolean };

// An event read whole and checked against the stream so far: how it changes the reassembly, which nothing can refuse.
type Change = (state: State) => State;
const unchanged: Change = (state) => state;
// An event as it was read: applied, with the fields it was applied without and those no read asked for, or not applied.
type Applied = ({ is: "applied" } & Read<Change>) | { is: "refused"; refusals: readonly Refusal[] };

// The block types a tool's input streams into.
const streamsInput = ["tool_use", "server_tool_use", "mcp_tool_use"];

const string = value(kinds.string);
const index = value(kinds.integer);
// What a message_delta says of the stop, a field it may leave out.
const stopField = optional(nullable(string));
// [LAW:parse-dont-validate] The usage an event brings, an object, or none: a usage of another type is dropped at the
// event, which names it, and the message builds without it. Its counts are read where the message is shown, once.
const usage = orElse(optional(nullable(value(kinds.object))), undefined);

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both: the message's fields, but its content's, are read where the
// message is shown. [LAW:no-silent-failure] An event is applied whole or not at all: one that does not read, or does
// not follow the events before it, is shown raw under its event name, with why.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let state: State = { phase: { is: "before" }, errors: [] };
  const blocks: Block[] = [];

  // The message every event but message_start, a ping and an error builds on, from message_start until message_stop.
  const building = (type: string): Message => {
    const { phase } = state;
    if (phase.is === "before") throw new Malformed(`${type} before message_start`);
    if (phase.is === "stopped") throw new Malformed(`${type} after message_stop`);
    return phase.message;
  };
  // A block's deltas and its stop come between its start and its stop.
  const open = (type: string, at: number): { message: Message; target: Building } => {
    const message = building(type);
    const target = message.content.get(at);
    if (target === undefined) throw new Malformed(`no content block ${at} has started`);
    if (target.stopped) throw new Malformed(`content block ${at} has stopped`);
    return { message, target };
  };
  const rebuilt = (message: Message): Change => (state) => ({ ...state, phase: { is: "building", message } });
  const withBlock = (message: Message, at: number, block: Building): Change => rebuilt({ ...message, content: new Map(message.content).set(at, block) });

  const events = new Map<string, (type: string) => Reader<Change>>([
    [
      "message_start",
      () =>
        mapped(object({ message: holding(object({ type: value(kinds.among(["message"])), usage })) }), ({ message }): Change => {
          if (state.phase.is !== "before") throw new Malformed("the message has already started");
          // Its type read as a non-streaming response's is, so both leave the same fields to show.
          return rebuilt({ fields: message.others, usage: message.read.usage, content: new Map() });
        }),
    ],
    [
      "content_block_start",
      (type) =>
        mapped(object({ index, content_block: taggedFields("type", (is) => mapped(starts.get(is) ?? startOther, (start) => ({ is, start }))) }), ({ index, content_block: { is, start } }): Change => {
          const message = building(type);
          if (message.content.has(index)) throw new Malformed(`content block ${index} has already started`);
          const { input: sent, ...others } = start.others;
          const streams = streamsInput.includes(is);
          const input: Streamed = streams ? { is: "streaming", start: sent === undefined ? {} : { input: sent }, json: "" } : { is: "sent" };
          return withBlock(message, index, { type: is, others: streams ? others : start.others, extended: { ...unextended, ...start.read }, input, stopped: false });
        }),
    ],
    [
      "content_block_delta",
      (type) =>
        mapped(object({ index, delta: taggedFields("type", (is) => deltaOf(is)) }), ({ index, delta }): Change => {
          const { message, target } = open(type, index);
          return withBlock(message, index, delta(target));
        }),
    ],
    [
      "content_block_stop",
      (type) =>
        mapped(object({ index }), ({ index }): Change => {
          const { message, target } = open(type, index);
          return withBlock(message, index, { ...target, others: { ...target.others, ...stoppedInput(target.input) }, input: { is: "sent" }, stopped: true });
        }),
    ],
    [
      "message_delta",
      (type) =>
        mapped(object({ delta: object({ stop_reason: stopField, stop_sequence: stopField }), usage, context_management: optional(raw) }), ({ delta, usage, context_management }): Change => {
          const message = building(type);
          // What it says of the stop, and what the API did to the context, which a whole response holds among the
          // message's fields. The counts it brings replace the message's, one by one, and the others stand; one that
          // brings none leaves the message's as they were.
          const said = Object.entries({ ...delta, context_management }).filter(([, said]) => said !== undefined);
          return rebuilt({ ...message, fields: { ...message.fields, ...Object.fromEntries(said) }, usage: usage === undefined || usage === null ? message.usage : { ...message.usage, ...usage } });
        }),
    ],
    // An error may come before the message begins, as the stream's one event, or while it builds, never after its stop.
    [
      "error",
      (type) => (json, at) => {
        const event = apiError(json, at);
        if (state.phase.is === "stopped") throw new Malformed(`${type} after message_stop`);
        // Its fields beside the error are the error's, as a whole response's are.
        const error = formatError(event.value);
        return { value: (state) => ({ ...state, errors: [...state.errors, error] }), unread: [], dropped: event.dropped };
      },
    ],
    // A keep-alive, which may come at any time and builds nothing.
    ["ping", () => mapped(object({}), (): Change => unchanged)],
    // The stream's end, which the trailers already mark: it carries no content.
    [
      "message_stop",
      (type) =>
        mapped(object({}), (): Change => {
          const message = building(type);
          return (state) => ({ ...state, phase: { is: "stopped", message } });
        }),
    ],
  ]);
  const notApplied = (is: string): Reader<Change> => () => {
    throw new Malformed(`${is} is not an event this view applies`);
  };

  // [LAW:one-source-of-truth] An event's block, when it has one: what it says beside the message it builds, the one
  // shape of an event not applied, of one applied without a field, and of one holding fields no read asked for.
  const eventBlock = (event: string, data: string, read: Applied): Block[] => {
    const said: Part[] =
      read.is === "refused" ? [{ ...doesNotFit(worded(read.refusals)), label: "not applied" }] : [...(read.dropped.length === 0 ? [] : [doesNotFit(worded(read.dropped))]), ...unreadParts(read.unread)];
    return said.length === 0 ? [] : [{ category: "http", name: `${event} event`, parts: [...said, { id: "data", label: "data", kind: "text", form: "verbatim", text: data }] }];
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events: arrived, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event, data } of arrived) {
        const read = attempt(
          (): Applied => ({ is: "applied", ...taggedFields("type", (is) => (events.get(is) ?? notApplied)(is))(parseJson(data, "its data"), []) }),
          (refusals): Applied => ({ is: "refused", refusals }),
        );
        if (read.is === "applied") state = read.value(state);
        blocks.push(...eventBlock(event, data, read));
      }
      const { phase, errors } = state;
      return { message: phase.is === "before" ? undefined : replyOf(phase.message), errors: [...errors], blocks: [...blocks], tail };
    },
  };
}

// The message as a whole response would have returned it: its fields, its usage where an event brought one, and its
// content in order.
const replyOf = ({ fields, usage, content }: Message): Record<string, unknown> => ({
  ...fields,
  ...(usage === undefined ? {} : { usage }),
  content: [...content.entries()].sort(([a], [b]) => a - b).map(([, built]) => assembled(built)),
});

// A content block, a copy of its own: its fields as far as its deltas have extended them, a field neither its start nor
// a delta sent unsent, and, while its tool input streams, that input's JSON so far, `partial_json`, in place of the
// input its start sent, which that JSON becomes at its stop.
function assembled({ type, others, extended, input }: Building): Record<string, unknown> {
  const sent = Object.fromEntries(Object.entries(extended).filter(([, value]) => value !== undefined));
  return { type, ...others, ...sent, ...(input.is === "streaming" ? { partial_json: input.json } : {}) };
}

// A tool's input at its block's stop, where it is whole: the JSON its deltas sent, so input that is not JSON by then is
// not applied, or, where no delta sent any, the input its start sent.
function stoppedInput(input: Streamed): Record<string, unknown> {
  if (input.is === "sent") return {};
  return input.json === "" ? input.start : { input: parseJson(input.json, "the block's streamed input") };
}

// [LAW:parse-dont-validate] What a block's start reads of each type a delta extends: the fields its deltas extend, so
// one that cannot be extended is dropped at the start that sends it, named there, and its deltas extend it from none.
const startText = { text: orElse(optional(string), undefined), citations: orElse(optional(value(kinds.list)), undefined) };
const startThinking = { thinking: orElse(optional(string), undefined), signature: orElse(optional(string), undefined) };
type Start = { read: Partial<Extended>; others: Record<string, unknown> };
const starts = new Map<string, Reader<Start>>([
  ["text", holding(object(startText))],
  ["thinking", holding(object(startThinking))],
]);
const startOther: Reader<Start> = holding(object<Record<never, never>>({}));

// [LAW:one-type-per-behavior] A content block delta: the block types it extends, and how it extends one, read from its
// fields; a delta of a type this view does not apply, or of a block type it does not extend, is not applied.
type Delta = (target: Building) => Building;
const delta =
  <T>(extend: readonly string[], reader: Reader<T>, apply: (target: Building, value: T) => Building) =>
  (is: string): Reader<Delta> =>
    mapped(reader, (read): Delta => (target) => {
      if (!extend.includes(target.type)) throw new Malformed(`${is} does not extend a ${target.type} block`);
      return apply(target, read);
    });
// The block's text field `field` extended by `text`, from none when its start did not send it.
const appended = (target: Building, field: "text" | "thinking" | "signature", text: string): Building => ({ ...target, extended: { ...target.extended, [field]: (target.extended[field] ?? "") + text } });

const deltas = new Map<string, (is: string) => Reader<Delta>>([
  ["text_delta", delta(["text"], object({ text: string }), (target, { text }) => appended(target, "text", text))],
  ["thinking_delta", delta(["thinking"], object({ thinking: string }), (target, { thinking }) => appended(target, "thinking", thinking))],
  ["signature_delta", delta(["thinking"], object({ signature: string }), (target, { signature }) => appended(target, "signature", signature))],
  [
    "input_json_delta",
    delta(streamsInput, object({ partial_json: string }), ({ input, ...target }, { partial_json }) => {
      // A tool's block streams its input from its start to its stop, and a stopped block takes no delta.
      if (input.is === "sent") throw new Malformed("the block's input is not streaming");
      return { ...target, input: { ...input, json: input.json + partial_json } };
    }),
  ],
  ["citations_delta", delta(["text"], object({ citation: raw }), (target, { citation }) => ({ ...target, extended: { ...target.extended, citations: [...(target.extended.citations ?? []), citation] } }))],
]);
const deltaOf = (is: string): Reader<Delta> =>
  (deltas.get(is) ?? ((is: string) => () => {
    throw new Malformed(`${is} is not a delta this view applies`);
  }))(is);
