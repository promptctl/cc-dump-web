import { Malformed } from "@cc-dump/log/failure";
import { attempt, carrying, kinds, nullable, object, optional, parseJson, raw, tagged, value, type Unread } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, restBlock, type Block } from "./blocks.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, the blocks of its
// events this view cannot apply, the fields of its events no case reads, a block for each thing they build (the
// message, each content block, the pings), and the text after the last complete event, which is the next event still
// arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; errors: Block[]; blocks: Block[]; fields: Block[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied before are not parsed or applied again, so a
// response read while it streams costs the text it receives, not its whole length each time.
// [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only grows, so each
// call's text begins with the text before, and the stream equals a reassembly of all of it at once. Each call returns
// objects of its own, so a stream already returned is never changed by an event after it.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

const str = value(kinds.string);
const index = value(kinds.integer);
const fields = value(kinds.object);

// [LAW:one-type-per-behavior] The deltas a content block is built by, one variant each.
type Delta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "citations_delta"; citation: unknown };
const delta = tagged<"type", Delta>("type", {
  text_delta: { text: str },
  thinking_delta: { thinking: str },
  signature_delta: { signature: str },
  input_json_delta: { partial_json: str },
  citations_delta: { citation: raw },
});

// [LAW:types-are-the-program] The content block types each delta extends, as the Messages API streams them: a text's
// text and its citations, a thinking's text and its signature, and a tool use's input.
const extending: Record<Delta["type"], readonly string[]> = {
  text_delta: ["text"],
  citations_delta: ["text"],
  thinking_delta: ["thinking"],
  signature_delta: ["thinking"],
  input_json_delta: ["tool_use", "server_tool_use", "mcp_tool_use"],
};

// A message as message_start begins it, read as a non-streaming response's is once built, and its usage, which a
// message_delta's extends.
type Started = { type: "message"; usage: Record<string, unknown> | undefined };
type Message = Record<string, unknown> & Started;

// [LAW:one-type-per-behavior] The events of a Messages stream, one variant each, read whole before any is applied, so an
// event that does not read changes nothing. A message_delta's delta replaces the message's fields it names, as the
// Messages API defines them; any other field of it is the event's, unread.
type Event =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: Record<string, unknown> & { type: string } }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string | null; stop_sequence: string | null }; usage: Record<string, unknown> }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: Record<string, unknown> };
const event = tagged<"type", Event>("type", {
  message_start: { message: carrying<Started>({ type: value(kinds.among(["message"] as const)), usage: optional(fields) }) },
  content_block_start: { index, content_block: carrying({ type: str }) },
  content_block_delta: { index, delta },
  content_block_stop: { index },
  message_delta: { delta: object({ stop_reason: nullable(str), stop_sequence: nullable(str) }), usage: fields },
  // The stream's end, which the trailers already mark: it carries no content.
  message_stop: {},
  // A keep-alive, which may come at any time and builds nothing.
  ping: {},
  error: { error: fields },
});

// [LAW:no-ambient-temporal-coupling] Where the message is in its life: not begun until message_start, built by the events
// after it, and stopped at message_stop, after which no event changes it.
type Phase = { at: "before" } | { at: "building"; message: Message } | { at: "stopped"; message: Message };

// [LAW:nothing-unseen] The fields of events no case reads, kept for what the events build, each at its path in its
// event, under the event's type and its place among the stream's events, so each event's value is its own.
type Kept = Unread[];
function keep(kept: Kept, type: string, place: number, unread: readonly Unread[]): void {
  for (const field of unread) kept.push({ ...field, at: [type, String(place), ...field.at] });
}

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that cannot be applied is
// shown raw under its event name, with why. [LAW:nothing-unseen] The fields of an event that no case reads are the
// event's: they are shown beside what it builds, at their path in it, and never merged into what it builds, which they
// would collide with.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  // The events applied or refused so far, the place of the next among them.
  let events = 0;
  let phase: Phase = { at: "before" };
  const heard = { message: [] as Kept, pings: [] as Kept };
  const content = new Map<number, Building>();
  const errors: Block[] = [];
  const blocks: Block[] = [];

  // Every event but message_start, a ping and an error builds on the message message_start began, until it stops.
  const building = (type: string): Message => {
    if (phase.at === "before") throw new Malformed(`${type} before message_start`);
    if (phase.at === "stopped") throw new Malformed(`${type} after message_stop`);
    return phase.message;
  };
  const started = (index: number) => {
    const target = content.get(index);
    if (target === undefined) throw new Malformed(`no content block ${index} has started`);
    return target;
  };
  // A block's deltas and its stop come between its start and its stop, while the message builds.
  const open = (type: string, index: number) => {
    building(type);
    const target = started(index);
    if (target.stopped !== undefined) throw new Malformed(`content block ${index} has stopped`);
    return target;
  };
  const apply = (data: unknown, place: number) => {
    const { value: read, unread } = event(data, []);
    switch (read.type) {
      case "message_start": {
        if (phase.at !== "before") throw new Malformed("the message has already started");
        phase = { at: "building", message: read.message };
        return keep(heard.message, read.type, place, unread);
      }
      case "content_block_start": {
        building(read.type);
        if (content.has(read.index)) throw new Malformed(`content block ${read.index} has already started`);
        const target: Building = { type: read.content_block.type, block: { ...read.content_block }, json: "", stopped: undefined, fields: [] };
        content.set(read.index, target);
        return keep(target.fields, read.type, place, unread);
      }
      case "content_block_delta": {
        const target = open(read.type, read.index);
        applyDelta(target, read.delta);
        return keep(target.fields, read.type, place, unread);
      }
      case "content_block_stop": {
        const target = open(read.type, read.index);
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        target.stopped = { input: target.json === "" ? undefined : parseJson(target.json, "the block's streamed input") };
        return keep(target.fields, read.type, place, unread);
      }
      case "message_delta": {
        // Its usage extends the counts message_start began.
        const prior = building(read.type);
        phase = { at: "building", message: { ...prior, ...read.delta, usage: { ...prior.usage, ...read.usage } } };
        return keep(heard.message, read.type, place, unread);
      }
      case "message_stop":
        phase = { at: "stopped", message: building(read.type) };
        return keep(heard.message, read.type, place, unread);
      case "ping":
        return keep(heard.pings, read.type, place, unread);
      case "error":
        errors.push(formatError(read.error, unread));
        return;
      default:
        return read satisfies never;
    }
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events: arrived, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event: name, data } of arrived) {
        const place = events++;
        attempt(
          () => apply(parseJson(data, "its data"), place),
          (reason) =>
            void blocks.push({
              category: "http",
              name: `${name} event`,
              parts: [
                { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: reason },
                { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
              ],
            }),
        );
      }
      const built = [...content.entries()].sort(([a], [b]) => a - b);
      const message = phase.at === "before" ? undefined : { ...phase.message, content: built.map(([, block]) => assembled(block)) };
      const held: [string, Kept][] = [["message", heard.message], ...built.map(([at, { fields }]): [string, Kept] => [`content block ${at}`, fields]), ["ping", heard.pings]];
      const fields = held.flatMap(([name, kept]) => restBlock(kept, "http", `${name} events`));
      return { message, errors: [...errors], blocks: [...blocks], fields, tail };
    },
  };
}

// A content block being built from its events: its type, the block, its tool input's JSON as far as it has streamed,
// once the block has stopped, that input parsed, and the fields of its events no case reads.
type Building = { type: string; block: Record<string, unknown>; json: string; stopped: { input: unknown } | undefined; fields: Kept };

// A content block, a copy of its own, with its tool input as far as it has streamed: the JSON once its block has
// stopped, and before that the text its deltas have sent, its `partial_json`, which is not yet JSON.
function assembled({ block, json, stopped }: Building): Record<string, unknown> {
  if (json === "") return { ...block };
  return stopped === undefined ? { ...block, partial_json: json } : { ...block, input: stopped.input };
}

// Applies a content block delta to the block it extends, or refuses it, changing nothing.
function applyDelta(target: Building, delta: Delta): void {
  if (!extending[delta.type].includes(target.type)) throw new Malformed(`${delta.type} does not extend a ${target.type} block`);
  const prior = (field: string): unknown => (Object.hasOwn(target.block, field) ? target.block[field] : undefined);
  // A delta extends its field from nothing when the block's start did not carry it.
  const append = (field: string, text: string) => {
    const before = prior(field) ?? "";
    if (typeof before !== "string") throw new Malformed(`${delta.type} extends a block whose ${field} is not a string`);
    target.block[field] = before + text;
  };
  switch (delta.type) {
    case "text_delta":
      return append("text", delta.text);
    case "thinking_delta":
      return append("thinking", delta.thinking);
    case "signature_delta":
      return append("signature", delta.signature);
    case "input_json_delta":
      target.json += delta.partial_json;
      return;
    case "citations_delta": {
      const before = prior("citations") ?? [];
      if (!Array.isArray(before)) throw new Malformed("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...before, delta.citation];
      return;
    }
    default:
      return delta satisfies never;
  }
}
