import { Malformed } from "@cc-dump/log/failure";
import { attempt, kept, kinds, nullable, object, optional, parse, parseJson, raw, tagged, value, type Kept } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { errorReaders, formatError, restBlock, type Block } from "./blocks.ts";

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

type AsSent = Kept<Record<never, never>>;
const asSent = kept(object<Record<never, never>>({}));

// [LAW:types-are-the-program] A content block delta, by its type, each the field it extends a block's by.
type Delta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "citations_delta"; citation: unknown }
  | { type: "compaction_delta"; content: string | null; encrypted_content: string | null };
const text = value(kinds.string);
const delta = kept(
  tagged<"type", Delta>("type", {
  text_delta: { text },
  thinking_delta: { thinking: text },
  signature_delta: { signature: text },
  input_json_delta: { partial_json: text },
  citations_delta: { citation: raw },
  compaction_delta: { content: nullable(text), encrypted_content: nullable(text) },
  }),
);

// [LAW:types-are-the-program] An event of a Messages stream this view applies, by its type, each with the fields it
// reads; a field none reads lands on what the event builds. message_start's message is read as a non-streaming
// response's is, its type taken, so both leave the same fields to show.
type Event =
  | { type: "message_start"; message: Kept<{ type: "message" }> }
  | { type: "content_block_start"; index: number; content_block: AsSent }
  | { type: "content_block_delta"; index: number; delta: Kept<Delta> }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: AsSent; usage: AsSent }
  | { type: "error"; error: unknown }
  | { type: "ping" }
  | { type: "message_stop" };
const index = value(kinds.integer);
const event = kept(
  tagged<"type", Event>("type", {
  message_start: { message: kept(object<{ type: "message" }>({ type: value(kinds.among(["message"] as const)) })) },
  content_block_start: { index, content_block: asSent },
  content_block_delta: { index, delta },
  content_block_stop: { index },
  message_delta: { delta: asSent, usage: asSent },
  error: errorReaders,
  ping: {},
  message_stop: {},
  }),
);

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both. [LAW:no-silent-failure] An event that cannot be applied is
// shown raw under its event name, with why; the fields of an event that no case reads land on what it builds, the
// message or the content block, so a field the API adds to an event is shown with theirs.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let message: Record<string, unknown> | undefined;
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
    const { fields, rest } = parse(event, data, "event");
    switch (fields.type) {
      case "message_start":
        if (message !== undefined) throw new Malformed("the message has already started");
        message = { ...fields.message.rest, ...rest };
        return;
      case "content_block_start":
        begun(fields.type);
        if (content.has(fields.index)) throw new Malformed(`content block ${fields.index} has already started`);
        content.set(fields.index, { block: { ...fields.content_block.rest, ...rest }, json: "", stopped: undefined });
        return;
      case "content_block_delta": {
        const target = open(fields.index);
        applyDelta(target, fields.delta);
        Object.assign(target.block, rest);
        return;
      }
      case "content_block_stop": {
        const target = open(fields.index);
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        target.stopped = { input: target.json === "" ? undefined : parseJson(target.json, "the block's streamed input") };
        Object.assign(target.block, rest);
        return;
      }
      case "message_delta": {
        const prior = begun(fields.type);
        message = { ...prior, ...rest, ...fields.delta.rest, usage: { ...parse(optional(asSent), prior.usage, "the message's usage")?.rest, ...fields.usage.rest } };
        return;
      }
      case "error":
        errors.push(formatError({ fields, rest }));
        return;
      // A keep-alive, which may come at any time and builds nothing: a field it carries is shown on its own.
      case "ping":
        blocks.push(...restBlock(rest, "http", "ping event"));
        return;
      // The stream's end, which the trailers already mark: it carries no content.
      case "message_stop":
        message = { ...begun(fields.type), ...rest };
        return;
      default:
        return fields satisfies never;
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
          () => apply(parseJson(data, "its data")),
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

// A content block being built from its events: the block, its tool input's JSON as far as it has streamed, and, once
// the block has stopped, that input parsed.
type Building = { block: Record<string, unknown>; json: string; stopped: { input: unknown } | undefined };

// A content block, a copy of its own, with its tool input as far as it has streamed: the JSON once its block has
// stopped, its text before that, which is not yet JSON.
function assembled({ block, json, stopped }: Building): Record<string, unknown> {
  if (json === "") return { ...block };
  return { ...block, input: stopped === undefined ? json : stopped.input };
}

function applyDelta(target: Building, { fields: delta, rest }: Kept<Delta>) {
  // A delta extends its field from nothing when the block's start did not carry it.
  const append = (field: string, text: string) => {
    const prior = target.block[field] ?? "";
    if (typeof prior !== "string") throw new Malformed(`${delta.type} extends a block whose ${field} is not a string`);
    target.block[field] = prior + text;
  };
  switch (delta.type) {
    case "text_delta":
      append("text", delta.text);
      break;
    case "thinking_delta":
      append("thinking", delta.thinking);
      break;
    case "signature_delta":
      append("signature", delta.signature);
      break;
    case "input_json_delta":
      target.json += delta.partial_json;
      break;
    case "citations_delta": {
      const prior = target.block.citations ?? [];
      if (!Array.isArray(prior)) throw new Malformed("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...prior, delta.citation];
      break;
    }
    // A compaction's summary streams as its content, and its opaque state is replaced by each delta that carries one.
    case "compaction_delta":
      if (delta.content !== null) append("content", delta.content);
      if (delta.encrypted_content !== null) target.block.encrypted_content = delta.encrypted_content;
      break;
    default:
      return delta satisfies never;
  }
  Object.assign(target.block, rest);
}
