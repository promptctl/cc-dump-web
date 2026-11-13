import type { Header } from "@cc-dump/proxy/format";
import type { Exchange, Of, RequestSide, ResponseSide } from "../exchanges.ts";
import { decodeBody, type Body } from "./body.ts";
import { fitting, formatBlock, formatError, Misfit, parseJson, raw, readObject, restParts, roleCategory, type Block, type Role } from "./blocks.ts";
import { reassemble } from "./stream.ts";

// A run of an exchange's blocks under one heading: the request's own, each message the request sends, the response.
export type Group = { title: "request" | Role | "message" | "response"; blocks: Block[] };

// One exchange of the conversation: the request, then its response (docs/design/01-mvp.md, F3).
export type FormattedExchange = { exchange: Exchange; groups: Group[] };

// A formatter of exchanges into the conversation: the Messages API exchanges, each as its blocks.
// [LAW:no-shared-mutable-globals] Its caches are its own. Formatting is a pure function of an exchange's events, which
// only ever grow, so an exchange whose latest event is unchanged is the one formatted before, the same object, and a
// response still streaming re-derives its response alone: its request, the largest body, decodes once.
export function createFormatter(): (exchanges: Exchange[]) => FormattedExchange[] {
  const requests = new WeakMap<object, Group[]>();
  const formatted = new WeakMap<object, FormattedExchange>();
  return (exchanges) =>
    exchanges.filter(isMessages).map((exchange) =>
      cached(formatted, exchange.latest, () => ({
        exchange,
        // An empty request side formats the same whatever the key, so any of the exchange's events will do.
        groups: [...cached(requests, latest(exchange.request) ?? exchange.latest, () => requestGroups(exchange.request)), responseGroup(exchange)],
      })),
    );
}

function cached<T>(cache: WeakMap<object, T>, key: object, compute: () => T): T {
  const value = cache.get(key) ?? compute();
  cache.set(key, value);
  return value;
}

function latest(side: RequestSide): object | undefined {
  return side.trailers ?? side.body.at(-1) ?? side.head;
}

// The Messages API's exchanges; requests to other paths are forwarded and not shown (F2). One whose request was not
// recorded is shown, since its path is not known.
function isMessages({ request: { head } }: Exchange): boolean {
  return head === undefined || (head.method === "POST" && new URL(head.url, "http://proxy").pathname === "/v1/messages");
}

function requestGroups(side: RequestSide): Group[] {
  const { head, trailers } = side;
  const body = decodeSide(side);
  const http = head === undefined ? notRecorded("request") : httpBlock("HTTP request", `${head.method} ${head.url} HTTP/${head.http_version}`, head.headers, trailers);
  const { blocks, messages } = requestBody(body.text, trailers !== undefined);
  return [{ title: "request", blocks: [http, ...undecoded(body), ...blocks] }, ...messages];
}

// The request body: its parameters, tool definitions and system prompt, then each message it sends.
function requestBody(text: string, complete: boolean): { blocks: Block[]; messages: Group[] } {
  if (!complete) return { blocks: leftover("request body so far", text), messages: [] };
  return fitting(
    () => {
      const body = readObject(parseJson(text, "request body"), "request body");
      const messages = body.array("messages").map(messageGroup);
      const system = systemBlocks(body.value("system"));
      const tools = toolBlocks(body.value("tools"));
      // Every other field is a parameter, so one the API adds is shown with the rest.
      return { blocks: [{ category: "metadata", name: "parameters", parts: [{ kind: "json", value: body.rest() }] }, ...tools, ...system], messages };
    },
    (reason) => ({ blocks: [{ category: "metadata", name: "request body", parts: [{ kind: "text", label: "does not fit", text: reason }, { kind: "text", text }] }], messages: [] }),
  );
}

function messageGroup(message: unknown): Group {
  return fitting(
    (): Group => {
      const fields = readObject(message, "message");
      const role = fields.string("role");
      if (!isRole(role)) throw new Misfit(`message's role ${role} is not user, assistant or system`);
      const content = fields.value("content");
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (!Array.isArray(blocks)) throw new Misfit("message's content is neither a string nor a list of blocks");
      const rest = restParts(fields, "message fields");
      return {
        title: role,
        blocks: [...blocks.map((block) => formatBlock(block, role)), ...(rest.length === 0 ? [] : [{ category: "metadata" as const, name: "message", parts: rest }])],
      };
    },
    (reason) => ({ title: "message", blocks: [raw("metadata", "message", reason, message)] }),
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

function toolBlocks(tools: unknown): Block[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Misfit("tools is not a list");
  return [{ category: "tools", name: `tool definitions: ${tools.length}`, parts: tools.map((tool) => ({ kind: "json", label: toolName(tool), value: tool })) }];
}

// A client tool's name; a server tool's type, which names it when it has no name.
function toolName(tool: unknown): string {
  const named = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : {};
  return [named.name, named.type].find((name) => typeof name === "string") ?? "tool";
}

function responseGroup({ response: side, end }: Exchange): Group {
  const { head, trailers } = side;
  const body = decodeSide(side);
  const http = head === undefined ? [] : [httpBlock("HTTP response", `HTTP/${head.http_version} ${head.status} ${head.reason}`, head.headers, trailers)];
  return { title: "response", blocks: [...http, ...undecoded(body), ...responseBody(head?.headers ?? [], body.text, trailers !== undefined), ...ending(end)] };
}

// The response body: a stream reassembled into its message; once complete, a message or an error; anything else raw.
function responseBody(headers: Header[], text: string, complete: boolean): Block[] {
  if (header(headers, "content-type")?.toLowerCase().startsWith("text/event-stream")) {
    const stream = reassemble(text);
    return [...(stream.message === undefined ? [] : messageBlocks(stream.message)), ...stream.blocks, ...leftover("stream tail", stream.tail)];
  }
  if (!complete) return leftover("response body so far", text);
  return fitting(
    () => {
      const body = readObject(parseJson(text, "response body"), "response body");
      switch (body.value("type")) {
        case "message":
          return messageBlocks(body.rest());
        case "error":
          return [formatError(body)];
        default:
          throw new Misfit("response body is neither a message nor an error");
      }
    },
    (reason) => [{ category: "metadata", name: "response body", parts: [{ kind: "text", label: "does not fit", text: reason }, { kind: "text", text }] }],
  );
}

// A response message: its content, then what the API reported about it.
function messageBlocks(message: Record<string, unknown>): Block[] {
  return fitting(
    (): Block[] => {
      const fields = readObject(message, "message");
      const content = fields.array("content").map((block) => formatBlock(block, "assistant"));
      const stopReason = show(fields.value("stop_reason"));
      const stopSequence = show(fields.value("stop_sequence"));
      return [
        ...content,
        { category: "metadata", name: `stop reason: ${stopReason}`, parts: [{ kind: "fields", fields: [["stop_reason", stopReason], ["stop_sequence", stopSequence]] }] },
        { category: "metadata", name: "usage", parts: [{ kind: "json", value: fields.value("usage") }] },
        { category: "metadata", name: "message", parts: restParts(fields, "fields") },
      ];
    },
    (reason) => [raw("metadata", "message", reason, message)],
  );
}

// How an exchange ended, as the blocks it adds: none for one that completed or has not ended.
function ending(end: Of<"end"> | undefined): Block[] {
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

function notRecorded(side: "request"): Block {
  return { category: "metadata", name: `HTTP ${side}`, parts: [{ kind: "text", text: `The ${side}'s head was not recorded.` }] };
}

// A side's body, decoded. Complete once its trailers are recorded; one without them is still arriving, or was cut off.
function decodeSide(side: RequestSide | ResponseSide): Body {
  return decodeBody(side.head?.headers ?? [], side.body, side.trailers !== undefined);
}

// [LAW:dataflow-not-control-flow] What a stage could not turn into blocks, shown raw: nothing, when nothing is left.
function undecoded(body: Body): Block[] {
  return body.error === undefined ? [] : [{ category: "metadata", name: "body not decoded", parts: [{ kind: "text", text: body.error }] }];
}
function leftover(name: string, text: string): Block[] {
  return text === "" ? [] : [{ category: "metadata", name, parts: [{ kind: "text", text }] }];
}

function header(headers: Header[], name: string): string | undefined {
  return headers.find(([field]) => field.toLowerCase() === name)?.[1];
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
}
