import { encoded, fieldOf, held, kinds, object, pathText, raw, refusalText, Refused, tagged, value, type Read, type Reader, type Refusal, type Unknown } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { errorBlock, type Block } from "./blocks.ts";
import { fieldValue, type Field } from "./parts.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), less its content; its content blocks, by index; the fields its events carried that no declaration
// reads, each by its path from its event's name; the errors its error events returned, which stand where the reply
// would have; the events it could not apply, each shown with why; and the text after the last complete event, which is
// the next event still arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; content: Built[]; fields: Field[]; errors: Block[]; refused: Block[]; tail: string };

// A content block as far as its events have built it, its JSON, and whether its message stopped before it did, so it
// was `cut`. [LAW:one-source-of-truth] One a stop ended is the same object in every stream after, so its formatting
// is kept with it (format.ts), and a finished block is not formatted again.
export type Built = { readonly block: unknown; readonly cut: boolean };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied
// before are not parsed or applied again, so a response read while it streams costs the text it receives, not its
// whole length each time. [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a
// body only grows, so each call's text begins with the text before, and the stream equals a reassembly of all of it at
// once. Each call returns objects of its own, so a stream already returned is never changed by an event after it.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// How a content block grows from its deltas, by its type: its text, its thinking, its tool input as JSON text, or not
// at all.
type Growth = "text" | "thinking" | "input" | "nothing";
const growths = new Map<string, Growth>([
  ["text", "text"],
  ["thinking", "thinking"],
  ["tool_use", "input"],
  ["server_tool_use", "input"],
  ["mcp_tool_use", "input"],
]);

// [LAW:types-are-the-program] A content block of the message: arriving, its JSON as its start and deltas built it and
// its tool input's JSON text so far; or stopped, built.
type Slot = { is: "arriving"; block: Record<string, unknown>; grows: Growth; input: string } | { is: "stopped"; built: Built };

// [LAW:types-are-the-program] The stream as its events have built it, a value of its own after each event, so an event
// that does not apply changes nothing.
type State = { message: Record<string, unknown> | undefined; content: ReadonlyMap<number, Slot>; fields: ReadonlyMap<string, unknown>; errors: readonly Block[] };

// The events of a Messages stream, as the API documents them, and the deltas of a content block.
type Delta =
  | { type: "text_delta"; text: string }
  | { type: "citations_delta"; citation: unknown }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string };
type Event =
  | { type: "message_start"; message: Record<string, unknown> }
  | { type: "content_block_start"; index: number; content_block: Record<string, unknown> }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: unknown; stop_sequence: unknown }; usage: Record<string, unknown>; context_management: unknown }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: Record<string, unknown> };

const text = value(kinds.string);
const index = value(kinds.integer);
// What a message_start begins: a message, its type read as a whole response's is, so both leave the same fields to
// show. Its fields, and a block's, are what it builds, read where it is formatted.
const message: Reader<Record<string, unknown>> = (json, at) => {
  const read = value(kinds.object)(json, at);
  if (fieldOf(read.value, "type") !== "message") throw new Refused([{ at: [...at, "type"], why: "is not message" }]);
  return read;
};
const delta = tagged<"type", Delta>("type", {
  text_delta: { text },
  citations_delta: { citation: value(kinds.sent) },
  thinking_delta: { thinking: text },
  signature_delta: { signature: text },
  input_json_delta: { partial_json: text },
});
const event = tagged<"type", Event>("type", {
  message_start: { message },
  content_block_start: { index, content_block: value(kinds.object) },
  content_block_delta: { index, delta },
  content_block_stop: { index },
  message_delta: { delta: object({ stop_reason: raw, stop_sequence: raw }), usage: value(kinds.object), context_management: raw },
  message_stop: {},
  ping: {},
  error: { error: value(kinds.object) },
});

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that does not read, does not
// follow the events before it, or is named apart from its data's type is shown under its event name, with why, and
// changes nothing.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let state: State = { message: undefined, content: new Map(), fields: new Map(), errors: [] };
  const refused: Block[] = [];

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event: name, data } of events) {
        const applied = held(step(state, name))(data, []).value;
        if (applied.is === "read") state = applied.value;
        else refused.push(notApplied(name, applied.refusals, data));
      }
      const content = [...state.content.entries()].sort(([a], [b]) => a - b).map(([, slot]) => (slot.is === "stopped" ? slot.built : { block: assembled(slot), cut: false }));
      const fields = [...state.fields].map(([path, value]): Field => [path, fieldValue(value)]);
      return { message: state.message, content, fields, errors: [...state.errors], refused: [...refused], tail };
    },
  };
}

// An event the stream could not apply, under its event name: why, and its data as it was received.
const notApplied = (name: string, refusals: readonly Refusal[], data: string): Block => ({
  category: "http",
  name: `${name} event`,
  parts: [
    { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: refusalText(refusals) },
    { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
  ],
});

// The read of one event's data, JSON text, as the stream it makes of `state`: its fields no declaration reads kept by
// their path from its type, a later event's at a path replacing an earlier one's.
const step =
  (state: State, name: string): Reader<State> =>
  (data, at) => {
    const read: Read<Event> = event(encoded(data, at).value, at);
    if (read.value.type !== name) throw new Refused([{ at: [...at, "type"], why: `is not ${JSON.stringify(name)}, the event's name` }]);
    const fields = read.unknown.reduce((kept, { at: path, value }: Unknown) => new Map(kept).set(pathText([read.value.type, ...path]), value), state.fields);
    return { ...read, value: apply({ ...state, fields }, read.value) };
  };

// [LAW:single-enforcer] What each event does to the stream. Every event but message_start, a ping and an error builds
// on the message message_start began; a block's deltas and its stop come between its start and its stop.
function apply(state: State, event: Event): State {
  const begun = (): Record<string, unknown> => {
    if (state.message === undefined) throw new Refused([{ at: [], why: "comes before message_start" }]);
    return state.message;
  };
  const arriving = (at: number): Extract<Slot, { is: "arriving" }> => {
    const slot = state.content.get(at);
    if (slot === undefined) throw new Refused([{ at: ["index"], why: "names no content block that has started" }]);
    if (slot.is === "stopped") throw new Refused([{ at: ["index"], why: "names a content block that has stopped" }]);
    return slot;
  };
  const content = (at: number, slot: Slot) => ({ ...state, content: new Map(state.content).set(at, slot) });
  switch (event.type) {
    case "message_start":
      if (state.message !== undefined) throw new Refused([{ at: [], why: "the message has already started" }]);
      return { ...state, message: event.message };
    case "content_block_start": {
      begun();
      if (state.content.has(event.index)) throw new Refused([{ at: ["index"], why: "names a content block that has already started" }]);
      const type = fieldOf(event.content_block, "type");
      return content(event.index, { is: "arriving", block: event.content_block, grows: (kinds.string.fits(type) ? growths.get(type) : undefined) ?? "nothing", input: "" });
    }
    case "content_block_delta": {
      const slot = arriving(event.index);
      return content(event.index, grown(slot, event.delta));
    }
    case "content_block_stop": {
      const slot = arriving(event.index);
      // A tool's input is whole at its block's stop, so input that is not JSON by then does not apply.
      const input = slot.input === "" ? undefined : held(encoded)(slot.input, ["input"]).value;
      if (input?.is === "refused") throw new Refused([{ at: [], why: `the input streamed to content block ${event.index} is not JSON` }]);
      return content(event.index, { is: "stopped", built: { block: input === undefined ? { ...slot.block } : { ...slot.block, input: input.value }, cut: false } });
    }
    // What the message ends with: why it stopped and its counts, and how its context was managed, which a whole
    // response holds on the message itself.
    case "message_delta": {
      const prior = begun();
      const usage = fieldOf(prior, "usage");
      const { stop_reason, stop_sequence } = event.delta;
      const { context_management } = event;
      return {
        ...state,
        message: {
          ...prior,
          ...(stop_reason === undefined ? {} : { stop_reason }),
          ...(stop_sequence === undefined ? {} : { stop_sequence }),
          ...(context_management === undefined ? {} : { context_management }),
          usage: { ...(kinds.object.fits(usage) ? usage : {}), ...event.usage },
        },
      };
    }
    // The stream's end, which the trailers already mark: a block still arriving stops as far as it came, cut.
    case "message_stop": {
      begun();
      return { ...state, content: new Map([...state.content].map(([at, slot]) => [at, slot.is === "stopped" ? slot : { is: "stopped", built: { block: assembled(slot), cut: true } }])) };
    }
    // A keep-alive, which may come at any time and builds nothing.
    case "ping":
      return state;
    case "error":
      return { ...state, errors: [...state.errors, errorBlock(event.error, [])] };
  }
}

// A block as far as it has arrived: its tool input as the JSON text sent so far, which is not yet JSON.
function assembled({ block, grows, input }: Extract<Slot, { is: "arriving" }>): Record<string, unknown> {
  return grows === "input" && input !== "" ? { ...block, input } : { ...block };
}

// A block extended by a delta of the kind it grows by, from nothing when its start did not carry the field.
function grown(slot: Extract<Slot, { is: "arriving" }>, delta: Delta): Slot {
  const grows: Record<Delta["type"], Growth> = { text_delta: "text", citations_delta: "text", thinking_delta: "thinking", signature_delta: "thinking", input_json_delta: "input" };
  if (grows[delta.type] !== slot.grows) throw new Refused([{ at: ["delta", "type"], why: `does not extend a ${String(fieldOf(slot.block, "type"))} block` }]);
  const appended = (field: string, more: string): Slot => {
    const prior = fieldOf(slot.block, field) ?? "";
    if (!kinds.string.fits(prior)) throw new Refused([{ at: ["delta", "type"], why: `extends a block whose ${field} is not a string` }]);
    return { ...slot, block: { ...slot.block, [field]: prior + more } };
  };
  switch (delta.type) {
    case "text_delta":
      return appended("text", delta.text);
    case "thinking_delta":
      return appended("thinking", delta.thinking);
    case "signature_delta":
      return appended("signature", delta.signature);
    case "input_json_delta":
      return { ...slot, input: slot.input + delta.partial_json };
    case "citations_delta": {
      const prior = fieldOf(slot.block, "citations") ?? [];
      if (!kinds.list.fits(prior)) throw new Refused([{ at: ["delta", "type"], why: "extends a block whose citations are not a list" }]);
      return { ...slot, block: { ...slot.block, citations: [...prior, delta.citation] } };
    }
  }
}

