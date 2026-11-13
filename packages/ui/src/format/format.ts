import type { Header } from "@cc-dump/proxy/format";
import { latest, type Exchange, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { fitting, formatBlock, formatError, Misfit, parseJson, raw, readObject, restBlock, roleCategory, type Block, type BlockOrNone, type Role } from "./blocks.ts";
import { createReassembly, type Reassembly, type Stream } from "./stream.ts";

// A run of an exchange's blocks under one heading: the request's own, each message the request sends, the response.
// [LAW:types-are-the-program] `key` names what a group or a block is, unique among its siblings, so it never moves as
// blocks arrive around it: a choice the view keeps about a block (expanded, scrolled to) stays with that block.
export type Group = { key: string; title: "request" | Role | "message" | "response"; blocks: KeyedBlock[] };
export type KeyedBlock = Block & { key: string };

// One exchange of the conversation: the request, then its response (docs/design/01-mvp.md, F3).
export type FormattedExchange = { exchange: Exchange; groups: Group[] };

// A formatter of exchanges into the conversation: the Messages API exchanges, each as its blocks.
// [LAW:no-shared-mutable-globals] Its caches are its own. Formatting is a pure function of an exchange's events, which
// only ever grow, so an exchange whose latest event is unchanged is the one formatted before, the same object, and a
// response still streaming re-derives its response alone: its request, the largest body, decodes once. Each side's
// body is decoded, and a stream reassembled, as its events arrive, so a response read while it streams costs what
// arrives, not its whole length each time.
export function createFormatter(): (exchanges: Exchange[]) => FormattedExchange[] {
  const requests = new WeakMap<object, Group[]>();
  const formatted = new WeakMap<object, FormattedExchange>();
  const decodings = new WeakMap<object, Decoding>();
  const reassemblies = new WeakMap<object, Reassembly>();
  // A side's decoding and reassembly are kept under its first event, which every later derivation of the side shares;
  // a side with no event yet has nothing to keep, so a key of its own is as good.
  const sides: Sides = {
    decode: (side) => decodeSide(cached(decodings, first(side) ?? {}, () => createDecoding(side.head?.headers ?? [])), side),
    reassemble: (side, body) => cached(reassemblies, first(side) ?? {}, createReassembly).reassemble(body.text, side.completedBy !== undefined),
  };
  return (exchanges) =>
    exchanges.filter(isMessages).map((exchange) =>
      cached(formatted, exchange.latest, () => ({
        exchange,
        // An empty request side formats the same whatever the key, so any of the exchange's events will do.
        groups: [...cached(requests, latest(exchange.request) ?? exchange.latest, () => requestGroups(sides, exchange.request)), responseGroup(sides, exchange)],
      })),
    );
}

// The decoding of each side's body and the reassembly of each streamed response, kept as they grow.
type Sides = { decode: (side: RequestSide | ResponseSide) => { body: Body; whole: boolean }; reassemble: (side: ResponseSide, body: Body) => Stream };

function first(side: RequestSide | ResponseSide): object | undefined {
  return side.head ?? side.body[0];
}

function cached<T>(cache: WeakMap<object, T>, key: object, compute: () => T): T {
  const value = cache.get(key) ?? compute();
  cache.set(key, value);
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

// The Messages API's exchanges; requests to other paths, and to a target that is no URL, are forwarded and not shown
// (F2). One whose request was not recorded is shown, since its path is not known.
function isMessages({ request: { head } }: Exchange): boolean {
  return head === undefined || (head.method === "POST" && URL.parse(head.url, "http://proxy")?.pathname === "/v1/messages");
}

function requestGroups(sides: Sides, side: RequestSide): Group[] {
  const { head, trailers } = side;
  const { body, whole } = sides.decode(side);
  const http = head === undefined ? notRecorded("request") : httpBlock("HTTP request", `${head.method} ${head.url} HTTP/${head.http_version}`, head.headers, trailers);
  const { blocks, messages } = requestBody(body.text, whole);
  return [{ key: "request", title: "request", blocks: [...one("http", [http]), ...one("undecoded", undecoded(body)), ...blocks] }, ...messages];
}

// The request body: its parameters, tool definitions and system prompt, then each message it sends.
function requestBody(text: string, whole: boolean): { blocks: KeyedBlock[]; messages: Group[] } {
  if (!whole) return { blocks: one("body", leftover("request body so far", text)), messages: [] };
  return fitting(
    () => {
      const body = readObject(parseJson(text, "request body"), "request body");
      const messages = body.array("messages").map(messageGroup);
      const system = systemBlocks(body.value("system"));
      const tools = toolBlocks(body.value("tools"));
      // Every other field is a parameter, so one the API adds is shown with the rest.
      const parameters: Block = { category: "metadata", name: "parameters", parts: [{ kind: "json", value: body.rest() }] };
      return { blocks: [...one("parameters", [parameters]), ...one("tools", tools), ...each("system", system)], messages };
    },
    (reason) => ({ blocks: one("body", [raw("metadata", "request body", reason, { kind: "text", text })]), messages: [] }),
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
      return { key, title: role, blocks: [...each("content", blocks.map((block) => formatBlock(block, role))), ...one("fields", restBlock(fields, "message"))] };
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

function responseGroup(sides: Sides, { response: side, end }: Exchange): Group {
  const { head, trailers } = side;
  const { body, whole } = sides.decode(side);
  // A response that has not begun has no head to miss.
  const http: BlockOrNone =
    head === undefined
      ? latest(side) === undefined
        ? []
        : [notRecorded("response")]
      : [httpBlock("HTTP response", `HTTP/${head.http_version} ${head.status} ${head.reason}`, head.headers, trailers)];
  return {
    key: "response",
    title: "response",
    blocks: [...one("http", http), ...one("undecoded", undecoded(body)), ...responseBody(sides, side, body, whole), ...one("end", ending(end))],
  };
}

// The response body: a stream reassembled into its message; once whole, a message or an error; anything else raw.
function responseBody(sides: Sides, side: ResponseSide, body: Body, whole: boolean): KeyedBlock[] {
  const { text } = body;
  if (headerValues(side.head?.headers ?? [], "content-type")[0]?.toLowerCase().startsWith("text/event-stream")) {
    const stream = sides.reassemble(side, body);
    return [...(stream.message === undefined ? [] : messageBlocks(stream.message)), ...each("event", stream.blocks), ...one("tail", leftover("stream tail", stream.tail))];
  }
  if (!whole) return one("body", leftover("response body so far", text));
  return fitting(
    (): KeyedBlock[] => {
      const body = readObject(parseJson(text, "response body"), "response body");
      switch (body.value("type")) {
        case "message":
          return messageBlocks(body.rest());
        case "error":
          return one("error", [formatError(body)]);
        default:
          throw new Misfit("response body is neither a message nor an error");
      }
    },
    (reason) => one("body", [raw("metadata", "response body", reason, { kind: "text", text })]),
  );
}

// A response message: its content, then what the API reported about it.
function messageBlocks(message: Record<string, unknown>): KeyedBlock[] {
  return fitting(
    (): KeyedBlock[] => {
      const fields = readObject(message, "message");
      const content = fields.array("content").map((block) => formatBlock(block, "assistant"));
      const stopReason = show(fields.value("stop_reason"));
      const stopSequence = show(fields.value("stop_sequence"));
      return [
        ...each("content", content),
        ...one("stop reason", [
          { category: "metadata", name: `stop reason: ${stopReason}`, parts: [{ kind: "fields", fields: [["stop_reason", stopReason], ["stop_sequence", stopSequence]] }] },
        ]),
        ...one("usage", [{ category: "metadata", name: "usage", parts: [{ kind: "json", value: fields.value("usage") }] }]),
        ...one("fields", restBlock(fields, "message")),
      ];
    },
    (reason) => one("message", [raw("metadata", "message", reason, { kind: "json", value: message })]),
  );
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
