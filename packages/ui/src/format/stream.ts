import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, restBlock, type Block } from "./blocks.ts";
import { fitting, Misfit, parseJson, readObject } from "./read.ts";

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
    if (message === undefined) throw new Misfit(`${type} before message_start`);
    return message;
  };
  const started = (index: unknown) => {
    const target = typeof index === "number" ? content.get(index) : undefined;
    if (target === undefined) throw new Misfit(`no content block ${JSON.stringify(index)} has started`);
    return target;
  };
  // A block's deltas and its stop come between its start and its stop.
  const open = (index: unknown) => {
    const target = started(index);
    if (target.stopped !== undefined) throw new Misfit(`content block ${JSON.stringify(index)} has stopped`);
    return target;
  };
  const apply = (data: unknown) => {
    const event = readObject(data, "event");
    const type = event.string("type");
    switch (type) {
      case "message_start": {
        if (message !== undefined) throw new Misfit("the message has already started");
        // Its type read as a non-streaming response's is, so both leave the same fields to show.
        const start = readObject(event.value("message"), "message");
        if (start.value("type") !== "message") throw new Misfit("message_start's message is not a message");
        message = { ...start.rest(), ...event.rest() };
        return;
      }
      case "content_block_start": {
        begun(type);
        const index = event.value("index");
        if (typeof index !== "number") throw new Misfit("content_block_start's index is not a number");
        if (content.has(index)) throw new Misfit(`content block ${index} has already started`);
        content.set(index, { block: { ...readObject(event.value("content_block"), "content_block").rest(), ...event.rest() }, json: "", stopped: undefined });
        return;
      }
      case "content_block_delta": {
        const target = open(event.value("index"));
        applyDelta(target, event.value("delta"));
        Object.assign(target.block, event.rest());
        return;
      }
      case "content_block_stop": {
        const target = open(event.value("index"));
        // A tool's input is whole at its block's stop, so input that is not JSON by then does not fit.
        target.stopped = { input: target.json === "" ? undefined : parseJson(target.json, "the block's streamed input") };
        Object.assign(target.block, event.rest());
        return;
      }
      case "message_delta": {
        const delta = readObject(event.value("delta"), "delta").rest();
        const usage = readObject(event.value("usage"), "usage").rest();
        const prior = begun(type);
        message = { ...prior, ...event.rest(), ...delta, usage: { ...(prior.usage as object), ...usage } };
        return;
      }
      case "error":
        errors.push(formatError(event));
        return;
      // A keep-alive, which may come at any time and builds nothing: a field it carries is shown on its own.
      case "ping":
        blocks.push(...restBlock(event, "http", "ping event"));
        return;
      // The stream's end, which the trailers already mark: it carries no content.
      case "message_stop":
        message = { ...begun(type), ...event.rest() };
        return;
      default:
        throw new Misfit(`${type} is not an event this view applies`);
    }
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event, data } of events) {
        fitting(
          () => apply(parseJson(data, "its data")),
          (reason) =>
            void blocks.push({
              category: "http",
              name: `${event} event`,
              parts: [
                { kind: "text", form: "verbatim", label: "not applied", text: reason },
                { kind: "text", form: "verbatim", label: "data", text: data },
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

// Applies a content block delta to the block it extends, its fields no case reads among them; a delta of a type not
// here is not applied.
function applyDelta(target: Building, data: unknown) {
  const delta = readObject(data, "delta");
  const type = delta.string("type");
  // A delta extends its field from nothing when the block's start did not carry it.
  const append = (field: string, text: string) => {
    const prior = target.block[field] ?? "";
    if (typeof prior !== "string") throw new Misfit(`${type} extends a block whose ${field} is not a string`);
    target.block[field] = prior + text;
  };
  switch (type) {
    case "text_delta":
      append("text", delta.string("text"));
      break;
    case "thinking_delta":
      append("thinking", delta.string("thinking"));
      break;
    case "signature_delta":
      append("signature", delta.string("signature"));
      break;
    case "input_json_delta":
      target.json += delta.string("partial_json");
      break;
    case "citations_delta": {
      const prior = target.block.citations ?? [];
      if (!Array.isArray(prior)) throw new Misfit("citations_delta extends a block whose citations are not a list");
      target.block.citations = [...prior, delta.value("citation")];
      break;
    }
    default:
      throw new Misfit(`${type} is not a delta this view applies`);
  }
  Object.assign(target.block, delta.rest());
}
