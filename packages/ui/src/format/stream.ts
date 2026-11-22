import { Malformed } from "@cc-dump/log/failure";
import { apart, attempt, kinds, mapped, nullable, object, optional, parseJson, raw, value, worded, type Path, type Reader, type Unread } from "@cc-dump/log/json";
import { serverSentEvents } from "@cc-dump/log/wire";
import { formatError, type Block } from "./blocks.ts";

// A streamed Messages response, reassembled: the message as far as its events have built it (undefined before
// message_start), the errors its error events returned, which stand where the reply would have, the blocks of the
// events this view did not apply, the fields of its events no read asked for, each under its event's type and its
// place among the events of that type, and the text after the last complete event, which is the next event still
// arriving or what a cut-off stream left.
export type Stream = { message: Record<string, unknown> | undefined; errors: Block[]; blocks: Block[]; unread: readonly Unread[]; tail: string };

// The reassembly of one streamed Messages response as its text arrives: `reassemble` takes the text decoded so far, and
// whether it is all the text there will be, and returns the stream as far as it has arrived. Events it has applied
// before are not parsed or applied again, so a response read while it streams costs the text it receives, not its whole
// length each time.
// [LAW:one-source-of-truth] The text is the truth and the reassembly is derived from it: a body only grows, so each
// call's text begins with the text before, and the stream equals a reassembly of all of it at once. Each call returns
// objects of its own, so a stream already returned is never changed by an event after it.
export type Reassembly = { reassemble: (text: string, complete: boolean) => Stream };

// A content block being built from its events: its type, its other fields, its tool input's JSON as far as it has
// streamed, and, once the block has stopped, that input parsed.
type Building = { type: string; block: Record<string, unknown>; json: string; stopped: { input: unknown } | undefined };

// An event read whole and checked against the stream so far: `commit` applies it, which nothing can refuse, and
// `unread`, its fields no read asked for.
type Applied = { commit: () => unknown; unread: readonly Unread[] };

// The block types a tool's input streams into.
const streamsInput = ["tool_use", "server_tool_use", "mcp_tool_use"];

// Reassembles the server-sent events of a Messages stream into the message they build, as a non-streaming response
// would have returned it, so one formatting serves both: the message's fields, but its content's, are read where the
// message is shown. [LAW:no-silent-failure] An event is applied whole or not at all: one that does not read, or does
// not follow the events before it, is shown raw under its event name, with why.
export function createReassembly(): Reassembly {
  let read = 0;
  // The text after the last complete event.
  let tail = "";
  let phase: "before" | "building" | "stopped" = "before";
  let message: Record<string, unknown> = {};
  const content = new Map<number, Building>();
  const errors: Block[] = [];
  const blocks: Block[] = [];
  const unread: Unread[] = [];
  const counted = new Map<string, number>();

  // Every event but message_start, a ping and an error builds on the message message_start began, until message_stop.
  const building = (type: string) => {
    if (phase === "before") throw new Malformed(`${type} before message_start`);
    if (phase === "stopped") throw new Malformed(`${type} after message_stop`);
  };
  // A block's deltas and its stop come between its start and its stop.
  const open = (type: string, index: number) => {
    building(type);
    const target = content.get(index);
    if (target === undefined) throw new Malformed(`no content block ${index} has started`);
    if (target.stopped !== undefined) throw new Malformed(`content block ${index} has stopped`);
    return target;
  };
  const events = new Map<string, (rest: Record<string, unknown>, type: string) => Applied>([
    [
      "message_start",
      (rest) => {
        if (phase !== "before") throw new Malformed("the message has already started");
        // Its type read as a non-streaming response's is, so both leave the same fields to show.
        const start = object({ message: mapped(apart("type", kinds.among(["message"])), ({ rest }) => rest) })(rest, []);
        return {
          unread: start.unread,
          commit: () => {
            message = start.value.message;
            phase = "building";
          },
        };
      },
    ],
    [
      "content_block_start",
      (rest, type) => {
        const start = object({ index: value(kinds.integer), content_block: apart("type", kinds.string) })(rest, []);
        const { index, content_block } = start.value;
        building(type);
        if (content.has(index)) throw new Malformed(`content block ${index} has already started`);
        return { unread: start.unread, commit: () => content.set(index, { type: content_block.is, block: content_block.rest, json: "", stopped: undefined }) };
      },
    ],
    [
      "content_block_delta",
      (rest, type) => {
        const event = object({ index: value(kinds.integer), delta: apart("type", kinds.string) })(rest, []);
        const { index, delta } = event.value;
        const target = open(type, index);
        const extension = deltas.get(delta.is);
        if (extension === undefined) throw new Malformed(`${delta.is} is not a delta this view applies`);
        if (!extension.extends.includes(target.type)) throw new Malformed(`${delta.is} does not extend a ${target.type} block`);
        const extended = extension.read(delta.rest, ["delta"]);
        const next = extended.apply(target);
        return { unread: [...event.unread, ...extended.unread], commit: () => content.set(index, next) };
      },
    ],
    [
      "content_block_stop",
      (rest, type) => {
        const stop = object({ index: value(kinds.integer) })(rest, []);
        const target = open(type, stop.value.index);
        // A tool's input is whole at its block's stop, so input that is not JSON by then is not applied.
        const input = target.json === "" ? undefined : parseJson(target.json, "the block's streamed input");
        return { unread: stop.unread, commit: () => content.set(stop.value.index, { ...target, stopped: { input } }) };
      },
    ],
    [
      "message_delta",
      (rest, type) => {
        const stop = optional(nullable(value(kinds.string)));
        // What the API did to the context, which a whole response holds among the message's fields.
        const event = object({ delta: object({ stop_reason: stop, stop_sequence: stop }), usage: value(kinds.object), context_management: optional(raw) })(rest, []);
        building(type);
        const { delta, usage, context_management } = event.value;
        const stopped = Object.fromEntries(Object.entries({ ...delta, context_management }).filter(([, said]) => said !== undefined));
        const prior = message.usage;
        return {
          unread: event.unread,
          commit: () => {
            message = { ...message, ...stopped, usage: { ...(kinds.object.fits(prior) ? prior : {}), ...usage } };
          },
        };
      },
    ],
    [
      "error",
      (rest) => {
        const event = object({ error: raw })(rest, []);
        return { unread: event.unread, commit: () => errors.push(formatError(event.value.error, [])) };
      },
    ],
    // A keep-alive, which may come at any time and builds nothing.
    ["ping", (rest) => ({ unread: object({})(rest, []).unread, commit: () => {} })],
    // The stream's end, which the trailers already mark: it carries no content.
    [
      "message_stop",
      (rest, type) => {
        const stop = object({})(rest, []);
        building(type);
        return {
          unread: stop.unread,
          commit: () => {
            phase = "stopped";
          },
        };
      },
    ],
  ]);

  // An event's data read and checked, or why it is not applied.
  const applied = (data: string): Applied => {
    const { is, rest } = apart("type", kinds.string)(parseJson(data, "its data"), []).value;
    const event = events.get(is);
    if (event === undefined) throw new Malformed(`${is} is not an event this view applies`);
    const { commit, unread: fields } = event(rest, is);
    // [LAW:nothing-unseen] Each field no read asked for, at its path under its event's type and its place among those
    // applied of that type, so the fields of every event are one object.
    const at = (path: Path): Path => [is, String(counted.get(is) ?? 0), ...path];
    return {
      unread: fields.map((field) => ({ ...field, at: at(field.at) })),
      commit: () => {
        commit();
        counted.set(is, (counted.get(is) ?? 0) + 1);
      },
    };
  };

  return {
    reassemble: (text, complete) => {
      if (text.length < read) throw new Error(`a stream reassembled to character ${read} was given ${text.length}: a body only grows`);
      const { events: arrived, rest } = serverSentEvents(tail + text.slice(read), complete);
      read = text.length;
      tail = rest;
      for (const { event, data } of arrived) {
        const change = attempt(
          (): Applied | undefined => applied(data),
          (refusals) => {
            blocks.push({
              category: "http",
              name: `${event} event`,
              parts: [
                { id: "misfit", label: "not applied", kind: "text", form: "verbatim", text: worded(refusals) },
                { id: "data", label: "data", kind: "text", form: "verbatim", text: data },
              ],
            });
            return undefined;
          },
        );
        change?.commit();
        unread.push(...(change?.unread ?? []));
      }
      const built = phase === "before" ? undefined : { ...message, content: [...content.entries()].sort(([a], [b]) => a - b).map(([, built]) => assembled(built)) };
      return { message: built, errors: [...errors], blocks: [...blocks], unread: [...unread], tail };
    },
  };
}

// A content block, a copy of its own, with its tool input as far as it has streamed: its JSON's text while its block
// streams, `partial_json`, in place of the input its start sent, which it becomes; the input that JSON is once its block
// has stopped.
function assembled({ type, block, json, stopped }: Building): Record<string, unknown> {
  if (!streamsInput.includes(type)) return { type, ...block };
  if (stopped === undefined) return { type, ...Object.fromEntries(Object.entries(block).filter(([name]) => name !== "input")), partial_json: json };
  return json === "" ? { type, ...block } : { type, ...block, input: stopped.input };
}

// [LAW:one-type-per-behavior] A content block delta: the block types it `extends`, and its read, which gives its fields
// no read asked for and how it changes the block it extends, refused when that block's field cannot be extended.
type Delta = { extends: readonly string[]; read: (rest: Record<string, unknown>, at: Path) => { unread: readonly Unread[]; apply: (target: Building) => Building } };
const delta = <T>(extend: readonly string[], reader: Reader<T>, apply: (target: Building, value: T) => Building): Delta => ({
  extends: extend,
  read: (rest, at) => {
    const read = reader(rest, at);
    return { unread: read.unread, apply: (target) => apply(target, read.value) };
  },
});

// The block's field `field` extended by `text`, from nothing when the block's start did not carry it.
function appended(target: Building, field: string, text: string): Building {
  const prior = Object.hasOwn(target.block, field) ? target.block[field] : "";
  if (!kinds.string.fits(prior)) throw new Malformed(`extends a block whose ${field} is not a string`);
  return { ...target, block: { ...target.block, [field]: prior + text } };
}

const string = value(kinds.string);
const deltas = new Map<string, Delta>([
  ["text_delta", delta(["text"], object({ text: string }), (target, { text }) => appended(target, "text", text))],
  ["thinking_delta", delta(["thinking"], object({ thinking: string }), (target, { thinking }) => appended(target, "thinking", thinking))],
  ["signature_delta", delta(["thinking"], object({ signature: string }), (target, { signature }) => appended(target, "signature", signature))],
  ["input_json_delta", delta(streamsInput, object({ partial_json: string }), (target, { partial_json }) => ({ ...target, json: target.json + partial_json }))],
  [
    "citations_delta",
    delta(["text"], object({ citation: raw }), (target, { citation }) => {
      const prior = Object.hasOwn(target.block, "citations") ? target.block.citations : [];
      if (!kinds.list.fits(prior)) throw new Malformed("extends a block whose citations are not a list");
      return { ...target, block: { ...target.block, citations: [...prior, citation] } };
    }),
  ],
]);
