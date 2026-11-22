import { serverSentEvents } from "@cc-dump/log/wire";
import { Malformed } from "@cc-dump/log/failure";
import { attempt, kinds, nullable, parseJson, raw, readShown, tagged, value, type Unread } from "@cc-dump/log/json";
import { formatError, restBlock, type Block } from "./blocks.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, the blocks of its other
// events that are not part of the message (a ping's fields, an event this view cannot apply), and the text after the
// last complete event, which is the next event still arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; errors: Block[]; blocks: Block[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied before are not parsed or applied again, so a
// response read while it streams costs the text it receives, not its whole length each time.
// [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only grows, so each
// call's text begins with the text before, and the stream equals a reassembly of all of it at once. Each call returns
// objects of its own, so a stream already returned is never changed by an event after it.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that cannot be applied is
// shown raw under its event name, with why; the fields of an event that no case reads land on what it builds, the
// message or the content block (`landing`), so a field the API adds to an event is shown with theirs.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let message: Record<string, unknown> | undefined;
  const landedOnMessage = new Set<string>();
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
    const { value: event, unread } = readShown(eventReader, data, "event");
    switch (event.type) {
      case "message_start": {
        if (message !== undefined) throw new Malformed("the message has already started");
        const started = { ...event.message };
        landing(started, landedOnMessage, unread)();
        message = started;
        return;
      }
      case "content_block_start": {
        begun(event.type);
        if (content.has(event.index)) throw new Malformed(`content block ${event.index} has already started`);
        const building: Building = { block: { ...event.content_block }, landed: new Set(), json: "", stopped: undefined };
        landing(building.block, building.landed, unread)();
        content.set(event.index, building);
        return;
      }
      case "content_block_delta": {
        const target = open(event.index);
        const land = landing(target.block, target.landed, unread);
        applyDelta(target, event.delta);
        land();
        return;
      }
      case "content_block_stop": {
        const target = open(event.index);
        const land = landing(target.block, target.landed, unread);
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        target.stopped = { input: target.json === "" ? undefined : parseJson(target.json, "the block's streamed input") };
        land();
        return;
      }
      case "message_delta": {
        const prior = begun(event.type);
        const delta = { ...prior, ...event.delta, usage: { ...(prior.usage as object), ...event.usage } };
        landing(delta, landedOnMessage, unread)();
        message = delta;
        return;
      }
      case "error":
        errors.push(formatError(event.error, unread));
        return;
      // A keep-alive, which may come at any time and builds nothing: a field it carries is shown on its own.
      case "ping":
        blocks.push(...restBlock(unread, "http", "ping event"));
        return;
      // The stream's end, which the trailers already mark: it carries no content.
      case "message_stop":
        landing(begun(event.type), landedOnMessage, unread)();
        return;
      default:
        return event satisfies never;
    }
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event, data } of events) {
        attempt(
          () => apply(parseJson(data, "event")),
          (reason) =>
            void blocks.push({
              category: "http",
              name: `${event} event`,
              parts: [
                { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: reason },
                { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
              ],
            }),
        );
      }
      const built = message === undefined ? undefined : { ...message, content: [...content.entries()].sort(([a], [b]) => a - b).map(([, built]) => assembled(built)) };
      return { message: built, errors: [...errors], blocks: [...blocks], tail };
    },
  };
}

// A content block being built from its events: the block, the fields its events landed on it, its tool input's JSON as
// far as it has streamed, and, once the block has stopped, that input parsed.
type Building = { block: Record<string, unknown>; landed: Set<string>; json: string; stopped: { input: unknown } | undefined };

// [LAW:no-silent-failure] The landing of an event's fields that no case reads, its own and its delta's, on `target`,
// what the event builds, done once the event has applied: each by its name, as its own field, so a key such as
// `__proto__` is a field like any other. One lands again where one of its name landed before, as a delta's estimate
// does with each delta; one that would land on a field the target holds otherwise, or on another of the event's, is
// refused before anything is applied, so neither is lost.
function landing(target: Record<string, unknown>, landed: Set<string>, unread: readonly Unread[]): () => void {
  const names = unread.map(({ at }) => at.at(-1)!);
  unread.forEach(({ at }, index) => {
    const name = names[index]!;
    if (names.indexOf(name) !== index) throw new Malformed(`${at.join(": ")}: is named as another field the event holds`);
    if (Object.hasOwn(target, name) && !landed.has(name)) throw new Malformed(`${at.join(": ")}: would land on the ${name} it builds`);
  });
  return () =>
    unread.forEach(({ value }, index) => {
      Object.defineProperty(target, names[index]!, { value, enumerable: true, writable: true, configurable: true });
      landed.add(names[index]!);
    });
}

// A content block, a copy of its own, with its tool input as far as it has streamed: the JSON once its block has
// stopped, its text before that, which is not yet JSON.
function assembled({ block, json, stopped }: Building): Record<string, unknown> {
  if (json === "") return { ...block };
  return { ...block, input: stopped === undefined ? json : stopped.input };
}

// [LAW:types-are-the-program] A content block delta, by its type: the field of the block each extends.
type Delta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "citations_delta"; citation: unknown }
  | { type: "compaction_delta"; content: string | null };
const text = value(kinds.string);
const delta = tagged<"type", Delta>("type", {
  text_delta: { text },
  thinking_delta: { thinking: text },
  signature_delta: { signature: text },
  input_json_delta: { partial_json: text },
  citations_delta: { citation: raw },
  compaction_delta: { content: nullable(text) },
});

// A stream's events, by their type, each the fields a case applies: a message_start's message, read as a non-streaming
// response's is once it is built (format.ts), and a block's start whole, as what the events after them build on.
type StreamEvent =
  | { type: "message_start"; message: Record<string, unknown> }
  | { type: "content_block_start"; index: number; content_block: Record<string, unknown> }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: Record<string, unknown>; usage: Record<string, unknown> }
  | { type: "error"; error: unknown }
  | { type: "ping" }
  | { type: "message_stop" };
const fields = value(kinds.object);
const index = value(kinds.integer);
const eventReader = tagged<"type", StreamEvent>("type", {
  message_start: { message: fields },
  content_block_start: { index, content_block: fields },
  content_block_delta: { index, delta },
  content_block_stop: { index },
  message_delta: { delta: fields, usage: fields },
  error: { error: raw },
  ping: {},
  message_stop: {},
});

// Applies a content block delta to the block it extends.
function applyDelta(target: Building, delta: Delta) {
  // A delta extends its field from nothing when the block's start did not carry it.
  const append = (field: string, text: string) => {
    const prior = target.block[field] ?? "";
    if (typeof prior !== "string") throw new Malformed(`${delta.type} extends a block whose ${field} is not a string`);
    target.block[field] = prior + text;
  };
  switch (delta.type) {
    case "text_delta":
      return append("text", delta.text);
    case "thinking_delta":
      return append("thinking", delta.thinking);
    case "signature_delta":
      return append("signature", delta.signature);
    // A compaction delta of no content adds none, so a compaction streamed with none holds none, as one sent whole does.
    case "compaction_delta":
      return delta.content === null ? undefined : append("content", delta.content);
    case "input_json_delta":
      target.json += delta.partial_json;
      return;
    case "citations_delta": {
      const prior = target.block.citations ?? [];
      if (!Array.isArray(prior)) throw new Malformed("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...prior, delta.citation];
      return;
    }
    default:
      return delta satisfies never;
  }
}
