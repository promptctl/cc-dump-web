import { Malformed } from "@cc-dump/log/failure";
import { attempt, jsonObject, kinds, object, optional, parse, parseJson, raw, tagged, value, type Unread } from "@cc-dump/log/json";
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

// [LAW:one-type-per-behavior] The events of a Messages stream, one variant each, read whole before any is applied, so an
// event that does not read changes nothing.
type Event =
  | { type: "message_start"; message: unknown }
  | { type: "content_block_start"; index: number; content_block: unknown }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: unknown; usage: unknown }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: unknown };
const event = tagged<"type", Event>("type", {
  message_start: { message: raw },
  content_block_start: { index, content_block: raw },
  content_block_delta: { index, delta },
  content_block_stop: { index },
  message_delta: { delta: raw, usage: raw },
  // The stream's end, which the trailers already mark: it carries no content.
  message_stop: {},
  // A keep-alive, which may come at any time and builds nothing.
  ping: {},
  error: { error: raw },
});

// A message_start's message, read as a non-streaming response's is.
const startedMessage = object({ type: value(kinds.among(["message"])) });
// What a message_delta extends: the usage message_start began, where it began one.
const startedUsage = object({ usage: optional(value(kinds.object)) });

// The fields of events no case reads, kept for what the events build, each at its path in its event, its type first, so
// fields at one path are one field, of the latest event that carried it.
type Kept = Map<string, Unread>;
function keep(kept: Kept, type: string, unread: readonly Unread[]): void {
  for (const field of unread) {
    const at = [type, ...field.at];
    kept.set(JSON.stringify(at), { ...field, at });
  }
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
  let message: Record<string, unknown> | undefined;
  const heard = { message: new Map() as Kept, pings: new Map() as Kept };
  const content = new Map<number, Building>();
  const errors: Block[] = [];
  const blocks: Block[] = [];

  // Every event but message_start, a ping and an error builds on the message message_start began.
  const begun = (type: string) => {
    if (message === undefined) throw new Malformed(`${type} before message_start`);
    return message;
  };
  const started = (index: number) => {
    const target = content.get(index);
    if (target === undefined) throw new Malformed(`no content block ${index} has started`);
    return target;
  };
  // A block's deltas and its stop come between its start and its stop.
  const open = (index: number) => {
    const target = started(index);
    if (target.stopped !== undefined) throw new Malformed(`content block ${index} has stopped`);
    return target;
  };
  const apply = (data: unknown) => {
    const { value: read, unread } = event(data, []);
    switch (read.type) {
      case "message_start": {
        if (message !== undefined) throw new Malformed("the message has already started");
        parse(startedMessage, read.message, "message_start's message");
        message = { ...jsonObject(read.message, "message_start's message") };
        return keep(heard.message, read.type, unread);
      }
      case "content_block_start": {
        begun(read.type);
        if (content.has(read.index)) throw new Malformed(`content block ${read.index} has already started`);
        const building: Building = { block: { ...jsonObject(read.content_block, "content_block") }, json: "", stopped: undefined, fields: new Map() };
        content.set(read.index, building);
        return keep(building.fields, read.type, unread);
      }
      case "content_block_delta": {
        const target = open(read.index);
        applyDelta(target, read.delta);
        return keep(target.fields, read.type, unread);
      }
      case "content_block_stop": {
        const target = open(read.index);
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        target.stopped = { input: target.json === "" ? undefined : parseJson(target.json, "the block's streamed input") };
        return keep(target.fields, read.type, unread);
      }
      case "message_delta": {
        // Its delta replaces the message's top-level fields it names (stop_reason, stop_sequence), and its usage extends
        // the counts message_start began, as the Messages API defines them.
        const changes = jsonObject(read.delta, "delta");
        const usage = jsonObject(read.usage, "usage");
        const prior = begun(read.type);
        const { usage: began = {} } = parse(startedUsage, prior, "message_start's message");
        message = { ...prior, ...changes, usage: { ...began, ...usage } };
        return keep(heard.message, read.type, unread);
      }
      case "message_stop":
        begun(read.type);
        return keep(heard.message, read.type, unread);
      case "ping":
        return keep(heard.pings, read.type, unread);
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
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event: name, data } of events) {
        attempt(
          () => apply(parseJson(data, "its data")),
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
      const building = [...content.entries()].sort(([a], [b]) => a - b);
      const built = message === undefined ? undefined : { ...message, content: building.map(([, built]) => assembled(built)) };
      const held: [string, Kept][] = [["message", heard.message], ...building.map(([at, { fields }]): [string, Kept] => [`content block ${at}`, fields]), ["ping", heard.pings]];
      const fields = held.flatMap(([name, kept]) => restBlock([...kept.values()], "http", `${name} events`));
      return { message: built, errors: [...errors], blocks: [...blocks], fields, tail };
    },
  };
}

// A content block being built from its events: the block, its tool input's JSON as far as it has streamed, once the
// block has stopped, that input parsed, and the fields of its events no case reads.
type Building = { block: Record<string, unknown>; json: string; stopped: { input: unknown } | undefined; fields: Kept };

// A content block, a copy of its own, with its tool input as far as it has streamed: the JSON once its block has
// stopped, its text before that, which is not yet JSON.
function assembled({ block, json, stopped }: Building): Record<string, unknown> {
  if (json === "") return { ...block };
  return { ...block, input: stopped === undefined ? json : stopped.input };
}

// Applies a content block delta to the block it extends, or refuses it, changing nothing.
function applyDelta(target: Building, delta: Delta): void {
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
