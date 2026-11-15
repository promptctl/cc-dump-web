import { fieldOf } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import { latest, type Exchange, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { fitting, formatBlock, formatContent, formatError, Misfit, parseJson, raw, readObject, restBlock, roleCategory, type Block, type BlockOrNone, type Role } from "./blocks.ts";
import { createReassembly, type Reassembly, type Stream } from "./stream.ts";

// A run of an exchange's blocks under one heading: the request's own, each message the request sends, the response.
// [LAW:types-are-the-program] `key` names what a group or a block is, unique among its siblings, so it never moves as
// blocks arrive around it: a choice the view keeps about a block (expanded, scrolled to) stays with that block.
export type Group = { key: string; title: "request" | Role | "message" | "response"; blocks: KeyedBlock[] };
export type KeyedBlock = Block & { key: string };

// One exchange of the conversation: the request, then its response (docs/design/01-mvp.md, F3), and the facts its line
// prints.
export type FormattedExchange = { exchange: Exchange; facts: Facts; groups: Group[] };

// What differs between exchanges, for the exchange line (docs/design/02-design.md, "Print what varies"). `ordinal`: its
// place among the recording's exchanges shown, from 1. `began`: when its first event was recorded. `duration`: the
// milliseconds from then to its end, once it has ended. `status`: the response's, once its head is recorded. `model`:
// the one the request asks for, once its body is whole. The message's facts, once the response's message is read:
// `input` is the total of its usage's input tokens, the uncached, the cache read and the cache written together (the API
// reports the uncached alone as input_tokens), `cacheRead` and `cacheWritten` the cache's share of them, `output` the
// output tokens, and `stopReason` why it stopped, each undefined where the API did not say; so is the total where the
// uncached count is not said, and a cache count not said is none of the total. [LAW:one-source-of-truth] Each is read by the parse that already holds its object, the request
// body's or the message's, beside the blocks it makes, never back out of a block.
export type Facts = {
  ordinal: number;
  began: string;
  duration: number | undefined;
  status: number | undefined;
  model: string | undefined;
} & MessageFacts;
export type MessageFacts = {
  input: number | undefined;
  cacheRead: number | undefined;
  cacheWritten: number | undefined;
  output: number | undefined;
  stopReason: string | undefined;
};
const noMessage: MessageFacts = { input: undefined, cacheRead: undefined, cacheWritten: undefined, output: undefined, stopReason: undefined };

// A formatter of exchanges into the conversation: the Messages API exchanges, each as its blocks.
// [LAW:no-shared-mutable-globals] Its caches are its own. Formatting is a pure function of an exchange's events, which
// only ever grow, so an exchange whose latest event is unchanged is the one formatted before, the same object, and a
// side whose latest event is unchanged formats as before: a response still streaming re-derives its response alone,
// and its request, the largest body, decodes once. Each side's body is decoded, and a stream reassembled, as its
// events arrive, so a response read while it streams costs what arrives, not its whole length each time.
export function createFormatter(): (exchanges: Exchange[]) => FormattedExchange[] {
  const requests = new WeakMap<object, RequestShown>();
  const responses = new WeakMap<object, ResponseShown>();
  const formatted = new WeakMap<object, FormattedExchange>();
  const decodings = new WeakMap<object, Decoding>();
  const reassemblies = new WeakMap<object, Reassembly>();
  const sides: Sides = {
    decode: (side) => decodeSide(growing(decodings, side, () => createDecoding(side.head?.headers ?? [])), side),
    reassemble: (side, body) => growing(reassemblies, side, createReassembly).reassemble(body.text, side.completedBy !== undefined),
  };
  // The ordinal is the exchange's place among those shown, which can move under an unchanged exchange: one recorded
  // before its request head is shown until the head says it is not a Messages request. So an exchange formatted before is
  // the same object only at the same place; at another, its sides are still the ones formatted before.
  return (exchanges) =>
    exchanges.filter(isMessages).map((exchange, index) => {
      const ordinal = index + 1;
      const before = formatted.get(exchange.latest);
      if (before?.facts.ordinal === ordinal) return before;
      // An empty side formats the same whatever the key, so any of the exchange's events will do.
      const request = cached(requests, latest(exchange.request) ?? exchange.latest, () => requestGroups(sides, exchange.request));
      const response = cached(responses, latest(exchange.response) ?? exchange.latest, () => responseBlocks(sides, exchange.response));
      const { first: opened, end } = exchange;
      const shown: FormattedExchange = {
        exchange,
        facts: {
          ordinal,
          began: opened.timestamp,
          duration: end === undefined ? undefined : Date.parse(end.timestamp) - Date.parse(opened.timestamp),
          status: exchange.response.head?.status,
          model: request.model,
          ...response.message,
        },
        groups: [...request.groups, { key: "response", title: "response", blocks: [...response.blocks, ...one("end", ending(end))] }],
      };
      formatted.set(exchange.latest, shown);
      return shown;
    });
}

// The decoding of each side's body and the reassembly of each streamed response, kept as they grow.
type Sides = { decode: (side: RequestSide | ResponseSide) => { body: Body; whole: boolean }; reassemble: (side: ResponseSide, body: Body) => Stream };

// A request formatted: its groups and the model it asks for. A response formatted: its blocks and its message's facts.
type RequestShown = { groups: Group[]; model: string | undefined };
type ResponseShown = { blocks: KeyedBlock[]; message: MessageFacts };

function first(side: RequestSide | ResponseSide): object | undefined {
  return side.head ?? side.body[0];
}

function cached<T>(cache: WeakMap<object, T>, key: object, compute: () => T): T {
  const value = cache.get(key) ?? compute();
  cache.set(key, value);
  return value;
}

// A side's decoding or reassembly, kept under its first event, which every later derivation of the side shares, while
// the side grows. A complete side is not derived again, since its blocks are kept under its latest event, so its
// decoding is dropped, and with it the decoded text and the decoders' windows, which would otherwise live as long as
// the recording. A side with no event yet has nothing to keep, so a key of its own is as good.
function growing<T>(cache: WeakMap<object, T>, side: RequestSide | ResponseSide, create: () => T): T {
  const key = first(side) ?? {};
  const value = cache.get(key) ?? create();
  if (side.completedBy === undefined) cache.set(key, value);
  else cache.delete(key);
  return value;
}

// The blocks of one source, each keyed by it: a source of at most one block, or a list, whose blocks are keyed by their
// place in it, since a list only grows at its end.
function one(key: string, blocks: BlockOrNone): KeyedBlock[] {
  return blocks.map((block) => ({ ...block, key }));
}
function each(key: string, blocks: Block[]): KeyedBlock[] {
  return blocks.map((block, index) => ({ ...block, key: `${key}.${index}` }));
}
// The blocks of one content block of a message: the one block keeps the content block's key, so a text nothing was
// injected into is keyed as it always was, and a text split into several is keyed by the place of each piece in it.
function contentBlocks(key: string, blocks: Block[]): KeyedBlock[] {
  return blocks.length === 1 ? blocks.map((block) => ({ ...block, key })) : each(key, blocks);
}

// The Messages API's exchanges; requests to other paths, and to a target that is no URL, are forwarded and not shown
// (F2). One whose request was not recorded is shown, since its path is not known.
function isMessages({ request: { head } }: Exchange): boolean {
  return head === undefined || (head.method === "POST" && URL.parse(head.url, "http://proxy")?.pathname === "/v1/messages");
}

function requestGroups(sides: Sides, side: RequestSide): RequestShown {
  const { head, trailers } = side;
  const { body, whole } = sides.decode(side);
  const http = head === undefined ? notRecorded("request") : httpBlock("HTTP request", `${head.method} ${head.url} HTTP/${head.http_version}`, head.headers, trailers);
  const { blocks, messages, model } = requestBody(body.text, whole);
  return { groups: [{ key: "request", title: "request", blocks: [...one("http", [http]), ...one("undecoded", undecoded(body)), ...blocks] }, ...messages], model };
}

// The request body: its parameters, tool definitions and system prompt, then each message it sends; and the model among
// its parameters.
function requestBody(text: string, whole: boolean): { blocks: KeyedBlock[]; messages: Group[]; model: string | undefined } {
  if (!whole) return { blocks: one("body", leftover("request body so far", text)), messages: [], model: undefined };
  return fitting(
    () => {
      const body = readObject(parseJson(text, "request body"), "request body");
      const messages = body.array("messages").map(messageGroup);
      const system = systemBlocks(body.value("system"));
      const tools = toolBlocks(body.value("tools"));
      // Every other field is a parameter, so one the API adds is shown with the rest; the model stays among them.
      const rest = body.rest();
      const parameters: Block = { category: "metadata", name: "parameters", parts: [{ kind: "json", value: rest }] };
      return { blocks: [...one("parameters", [parameters]), ...one("tools", tools), ...each("system", system)], messages, model: typeof rest.model === "string" ? rest.model : undefined };
    },
    (reason) => ({ blocks: one("body", [raw("metadata", "request body", reason, { kind: "text", text })]), messages: [], model: undefined }),
  );
}

function messageGroup(message: unknown, index: number): Group {
  const key = `message.${index}`;
  return fitting(
    (): Group => {
      const fields = readObject(message, "message");
      const role = fields.string("role");
      if (!isRole(role)) throw new Misfit(`message's role ${role} is not user, assistant or system`);
      const content = fields.value("content");
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks)) throw new Misfit("message's content is neither a string nor a list of blocks");
      return { key, title: role, blocks: [...blocks.flatMap((block, index) => contentBlocks(`content.${index}`, formatContent(block, role))), ...one("fields", restBlock(fields, "message"))] };
    },
    (reason) => ({ key, title: "message", blocks: one("message", [raw("metadata", "message", reason, { kind: "json", value: message })]) }),
  );
}

function isRole(role: string): role is Role {
  return Object.hasOwn(roleCategory, role);
}

function systemBlocks(system: unknown): Block[] {
  if (system === undefined) return [];
  if (typeof system === "string") return [{ category: "system", name: "system prompt", parts: [{ kind: "text", text: system }] }];
  if (Array.isArray(system)) return system.map((block) => formatBlock(block, "system"));
  throw new Misfit("system is neither a string nor a list of blocks");
}

function toolBlocks(tools: unknown): BlockOrNone {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Misfit("tools is not a list");
  return [{ category: "tools", name: `tool definitions: ${tools.length}`, parts: tools.map((tool) => ({ kind: "json", label: toolName(tool), value: tool })) }];
}

// A client tool's name; a server tool's type, which names it when it has no name.
function toolName(tool: unknown): string {
  const named = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : {};
  return [named.name, named.type].find((name) => typeof name === "string") ?? "tool";
}

// The response's blocks, up to how its exchange ended, and its message's facts.
function responseBlocks(sides: Sides, side: ResponseSide): ResponseShown {
  const { head, trailers } = side;
  const { body, whole } = sides.decode(side);
  // A response that has not begun has no head to miss.
  const http: BlockOrNone =
    head === undefined
      ? latest(side) === undefined
        ? []
        : [notRecorded("response")]
      : [httpBlock("HTTP response", `HTTP/${head.http_version} ${head.status} ${head.reason}`, head.headers, trailers)];
  const { blocks, message } = responseBody(sides, side, body, whole);
  return { blocks: [...one("http", http), ...one("undecoded", undecoded(body)), ...blocks], message };
}

// The response body: a stream reassembled into its message; once whole, a message or an error; anything else raw.
function responseBody(sides: Sides, side: ResponseSide, body: Body, whole: boolean): ResponseShown {
  const { text } = body;
  if (headerValues(side.head?.headers ?? [], "content-type")[0]?.toLowerCase().startsWith("text/event-stream")) {
    const stream = sides.reassemble(side, body);
    // The text after the last complete event is the event still arriving until the side is complete, and only then
    // left over, as a stream cut short leaves it: shown earlier, it would come and go as each frame's bytes end.
    const tail = side.completedBy === undefined ? "" : stream.tail;
    const { blocks, message } = stream.message === undefined ? none([]) : messageBlocks(stream.message);
    return { blocks: [...blocks, ...each("event", stream.blocks), ...one("tail", leftover("stream tail", tail))], message };
  }
  if (!whole) return none(one("body", leftover("response body so far", text)));
  return fitting(
    (): ResponseShown => {
      const body = readObject(parseJson(text, "response body"), "response body");
      switch (body.value("type")) {
        case "message":
          return messageBlocks(body.rest());
        case "error":
          return none(one("error", [formatError(body)]));
        default:
          throw new Misfit("response body is neither a message nor an error");
      }
    },
    (reason) => none(one("body", [raw("metadata", "response body", reason, { kind: "text", text })])),
  );
}

// Blocks with no message among them.
const none = (blocks: KeyedBlock[]): ResponseShown => ({ blocks, message: noMessage });

// A response message: its content, then what the API reported about it; and, of what it reported, the facts.
function messageBlocks(message: Record<string, unknown>): ResponseShown {
  return fitting(
    (): ResponseShown => {
      const fields = readObject(message, "message");
      const content = fields.array("content").map((block) => formatBlock(block, "assistant"));
      const stopReason = fields.value("stop_reason");
      const stopSequence = show(fields.value("stop_sequence"));
      const usage = fields.value("usage");
      const uncached = tokens(usage, "input_tokens");
      const cacheRead = tokens(usage, "cache_read_input_tokens");
      const cacheWritten = tokens(usage, "cache_creation_input_tokens");
      return {
        blocks: [
          ...each("content", content),
          ...one("stop reason", [
            { category: "metadata", name: `stop reason: ${show(stopReason)}`, parts: [{ kind: "fields", fields: [["stop_reason", show(stopReason)], ["stop_sequence", stopSequence]] }] },
          ]),
          ...one("usage", [{ category: "metadata", name: "usage", parts: [{ kind: "json", value: usage }] }]),
          ...one("fields", restBlock(fields, "message")),
        ],
        message: {
          input: uncached === undefined ? undefined : uncached + (cacheRead ?? 0) + (cacheWritten ?? 0),
          cacheRead,
          cacheWritten,
          output: tokens(usage, "output_tokens"),
          stopReason: typeof stopReason === "string" ? stopReason : undefined,
        },
      };
    },
    (reason) => none(one("message", [raw("metadata", "message", reason, { kind: "json", value: message })])),
  );
}

// A count in a message's usage, where the API gave one: a count it gave as null, or not at all, is none.
function tokens(usage: unknown, name: string): number | undefined {
  const count = fieldOf(usage, name);
  return typeof count === "number" ? count : undefined;
}

// How an exchange ended, as the blocks it adds: none for one that completed or has not ended.
function ending(end: Of<"end"> | undefined): BlockOrNone {
  switch (end?.outcome) {
    case undefined:
    case "ok":
      return [];
    // A failure stands where the reply would have been, as an error the API returned does.
    case "error":
      return [{ category: "assistant", name: "error", parts: [{ kind: "text", text: end.error }] }];
    case "aborted":
      return [{ category: "metadata", name: "aborted", parts: [{ kind: "text", text: "The agent left the exchange before it completed." }] }];
    case "stopped":
      return [{ category: "metadata", name: "stopped", parts: [{ kind: "text", text: "The proxy stopped before the exchange completed." }] }];
  }
}

function httpBlock(name: string, line: string, headers: Header[], trailers: { headers: Header[] } | undefined): Block {
  const trailerParts = trailers === undefined || trailers.headers.length === 0 ? [] : [{ kind: "fields" as const, label: "trailers", fields: trailers.headers }];
  return { category: "metadata", name, parts: [{ kind: "text", text: line }, { kind: "fields", label: "headers", fields: headers }, ...trailerParts] };
}

function notRecorded(side: "request" | "response"): Block {
  return { category: "metadata", name: `HTTP ${side}`, parts: [{ kind: "text", text: `The ${side}'s head was not recorded, and with it its content type and coding.` }] };
}

// A side's body, decoded, and whether it is whole: complete, and decoded to the end. Only a whole body is parsed; any
// other is shown as far as it decoded.
function decodeSide(decoding: Decoding, side: RequestSide | ResponseSide): { body: Body; whole: boolean } {
  const complete = side.completedBy !== undefined;
  const body = decoding.decode(side.body, complete);
  return { body, whole: complete && body.error === undefined };
}

// [LAW:dataflow-not-control-flow] What a stage could not turn into blocks, shown raw: nothing, when nothing is left.
function undecoded(body: Body): BlockOrNone {
  return body.error === undefined ? [] : [{ category: "metadata", name: "body not decoded", parts: [{ kind: "text", text: body.error }] }];
}
function leftover(name: string, text: string): BlockOrNone {
  return text === "" ? [] : [{ category: "metadata", name, parts: [{ kind: "text", text }] }];
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
}
