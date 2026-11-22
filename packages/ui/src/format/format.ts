import { Malformed } from "@cc-dump/log/failure";
import { attempt, kinds, mapped, object, optional, parse, parseJson, raw as rawValue, readShown, tolerant, unreadFields, value } from "@cc-dump/log/json";
import { statusText } from "@cc-dump/log/status";
import type { Header } from "@cc-dump/proxy/format";
import { latest, trailersOf, type Exchange, type ExchangeShown, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { equal } from "./equal.ts";
import { formatBlock, formatContent, formatError, raw, restBlock, roleCategory, unreadParts, type Block, type BlockOrNone, type Role } from "./blocks.ts";
import { fieldValue, occurrences, pickedPart, valuePart, type Field, type PartBody } from "./parts.ts";
import { senderOf, type Sender } from "./wire.ts";
import { createReassembly, type Reassembly, type Stream } from "./stream.ts";

// A run of an exchange's blocks (docs/design/01-features.md, "Vocabulary"). `title`: the heading over it, which says who
// speaks, in the same word whether the content arrived as a reply or is resent as a message, or what the model is given
// beside the messages, its tools and its system prompt; `message` over a message that names no speaker this view knows.
// The envelope's groups, the request's own and the response's own, have none: they stand under the exchange's line, which
// already prints their facts. [LAW:types-are-the-program] `key` names what a group or a block is, unique among its
// siblings, so it never moves as blocks arrive around it: a choice the view keeps about a block (expanded, scrolled to)
// stays with that block.
export type Group = { key: string; title: Heading | undefined; blocks: KeyedBlock[] };
export type Heading = Role | "tools" | "message";
export type KeyedBlock = Block & { key: string; place?: Place };

// Where a block stands in the thread its exchange is part of (view/history.ts), which every request of the thread
// resends: among what the request sends besides its messages, its parameters, its tools or its system prompt; in the
// message at `index` among those a speaker sent, the user, the assistant or a role this view does not know; in a
// system-role message, the one at `index` among those standing before the speakers' message `before`; or in the reply,
// the message the response adds after the request's. [LAW:types-are-the-program] A place is where a block stands in the
// conversation, not in the request's list: Claude Code sends system-role messages among the others and leaves a
// trailing one out of the next request, which moves no speaker's message. A block with no place is the exchange's own,
// as its HTTP, its cache breakpoints and its usage are.
export type Place =
  | { in: "parameters" }
  | { in: "tools" }
  | { in: "system" }
  | { in: "message"; index: number }
  | { in: "system message"; before: number; index: number }
  | { in: "reply" };

// One exchange of the conversation (docs/design/01-features.md, F3): its envelope, then what its request sends, the tools,
// the system prompt and each message, then the reply; the facts its line prints; how many messages of a speaker's
// the request sends, which is the reply's index among them; and who sent it, by its head (format/wire.ts). Its exchange
// is as it stood when formatted, and holds no body.
export type FormattedExchange = { exchange: ExchangeShown; facts: Facts; groups: Group[]; messages: number; sender: Sender };

// What differs between exchanges, for the exchange line (docs/design/02-design.md, "Print what varies"). `began`: when its
// first event was recorded. `duration`: the
// milliseconds from then to its end, once it has ended. `status`: the response's, once its head is recorded. `model`:
// the one the request asks for, once its body is whole. `session`: the agent's session the request says it is part of,
// as Claude Code says it, the `session_id` in the JSON text of `metadata.user_id`; undefined where it does not. The message's facts, once the response's message is read:
// `uncached` is the input the cache did not hold (the API's input_tokens), `cacheRead` and `cacheWritten` the input read
// from the cache and written to it, `output` the output tokens, and `stopReason` why it stopped, each undefined where the
// API did not say. [LAW:one-source-of-truth] Each is read by the parse that already holds its object, the request body's
// or the message's, beside the blocks it makes, never back out of a block; the total input is derived from them
// (inputOf).
export type Facts = {
  began: string;
  duration: number | undefined;
  status: number | undefined;
  model: string | undefined;
  session: string | undefined;
} & MessageFacts;
export type MessageFacts = {
  uncached: number | undefined;
  cacheRead: number | undefined;
  cacheWritten: number | undefined;
  output: number | undefined;
  stopReason: string | undefined;
};
const noMessage: MessageFacts = { uncached: undefined, cacheRead: undefined, cacheWritten: undefined, output: undefined, stopReason: undefined };

// The total of a message's input tokens, the uncached, the cache read and the cache written together: none where the
// uncached count is not said, and a cache count not said is none of it.
export const inputOf = ({ uncached, cacheRead, cacheWritten }: MessageFacts): number | undefined =>
  uncached === undefined ? undefined : uncached + (cacheRead ?? 0) + (cacheWritten ?? 0);

// A formatter of exchanges into the conversation: the Messages API exchanges, each as its blocks.
// [LAW:no-shared-mutable-globals] Its caches are its own. Formatting is a pure function of an exchange's events, which
// only ever grow, and of nothing around it, not even its place among the exchanges shown. So an exchange whose latest
// event is unchanged is the one formatted before, the same object, and a
// side whose latest event is unchanged formats as before: a response still streaming re-derives its response alone,
// and its request, the largest body, decodes once. Each side's body is decoded, and a stream reassembled, as its
// events arrive, so a response read while it streams costs what arrives, not its whole length each time.
export function createFormatter(): (exchanges: Exchange[]) => FormattedExchange[] {
  const requests = new WeakMap<object, RequestShown>();
  const responses = new WeakMap<object, ResponseShown>();
  const formatted = new WeakMap<object, FormattedExchange>();
  const decodings = new WeakMap<object, Decoding>();
  const reassemblies = new WeakMap<object, Reassembly>();
  const intern = createInterning();
  const sides: Sides = {
    decode: (side) => decodeSide(growing(decodings, side, () => createDecoding(side.head?.headers ?? [])), side),
    reassemble: (side, body) => growing(reassemblies, side, createReassembly).reassemble(body.text, side.completedBy !== undefined),
  };
  return (exchanges) =>
    exchanges.filter(isMessages).map((exchange) => {
      const before = formatted.get(exchange.latest);
      if (before !== undefined) return before;
      // An empty side formats the same whatever the key, so any of the exchange's events will do.
      const request = cached(requests, latest(exchange.request) ?? exchange.latest, () => intern(requestShown(sides, exchange.request)));
      const response = cached(responses, latest(exchange.response) ?? exchange.latest, () => responseShown(sides, exchange.response));
      const { first: opened, end } = exchange;
      const ended = ending(end);
      const shown: FormattedExchange = {
        exchange: { trace_id: exchange.trace_id, request: { head: exchange.request.head }, response: { head: exchange.response.head }, end },
        facts: {
          began: opened.timestamp,
          duration: end === undefined ? undefined : Date.parse(end.timestamp) - Date.parse(opened.timestamp),
          status: exchange.response.head?.status,
          model: request.model,
          session: request.session,
          ...response.message,
        },
        groups: [
          { key: "request", title: undefined, blocks: request.own },
          { key: "response", title: undefined, blocks: [...response.own, ...one("end", ended.own)] },
          ...request.sent,
          { key: "reply", title: "assistant", blocks: [...response.reply, ...one("end", ended.reply)] },
        ],
        messages: request.messages,
        sender: senderOf(exchange.request.head),
      };
      formatted.set(exchange.latest, shown);
      return shown;
    });
}

// [LAW:domain-language] [LAW:one-source-of-truth] Interning, by hash consing's rule, of each block a request sends: one
// canonical object for every distinct value at a place, the group's key and its own. A request resends the conversation
// before it, so a block made again alike one made before at its place is that one, and so is a group whose title and
// blocks are all those of one before at its key: the formatter holds each block its requests send once, and a reference
// where a request resends it. The latest interned at a place is looked at first, since a request resends what the
// request before it in its thread sent. A group is interned after its blocks, so a group of resent blocks holds the very
// blocks of the one it is alike, and `equal` finds them the same at once.
function createInterning(): (shown: RequestShown) => RequestShown {
  const blocks = new Map<string, KeyedBlock[]>();
  const groups = new Map<string, Group[]>();
  const interned = <T>(table: Map<string, T[]>, at: string, made: T): T => {
    const there = table.get(at) ?? [];
    table.set(at, there);
    const found = there.findLast((one) => equal(one, made));
    if (found !== undefined) return found;
    there.push(made);
    return made;
  };
  return (shown) => ({
    ...shown,
    sent: shown.sent.map((group) => interned(groups, group.key, { ...group, blocks: group.blocks.map((block) => interned(blocks, `${group.key}/${block.key}`, block)) })),
  });
}

// The decoding of each side's body and the reassembly of each streamed response, kept as they grow.
type Sides = { decode: (side: RequestSide | ResponseSide) => { body: Body; whole: boolean }; reassemble: (side: ResponseSide, body: Body) => Stream };

// A request formatted: the blocks that are its exchange's own, the groups it sends, its tools, its system prompt and
// each message, how many of them are messages, the model it asks for and the session it is part of. A response
// formatted: the blocks that are its exchange's own, the reply's, and its message's facts.
type RequestShown = { own: KeyedBlock[]; sent: Group[]; messages: number } & Said;
// What a request's body says of it beside its blocks, once the body is whole.
type Said = { model: string | undefined; session: string | undefined };
const unsaid: Said = { model: undefined, session: undefined };
type ResponseShown = { own: KeyedBlock[]; reply: KeyedBlock[]; message: MessageFacts };

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

// [LAW:single-enforcer] The one maker of a keyed block, and so the one place a block's parts are held to having a name
// each (parts.ts, Part's `id`). [LAW:no-silent-failure] Every id is the formatter's own, so two parts of one name are its
// error, never the traffic's, and it throws.
export function keyed(block: Block, key: string): KeyedBlock {
  const ids = block.parts.map(({ id }) => id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined) throw new Error(`The formatter made the block ${key} with two parts named ${JSON.stringify(twice)}`);
  return { ...block, key };
}

// The blocks of one source, each keyed by it: a source of at most one block, or a list, whose blocks are keyed by their
// place in it, since a list only grows at its end.
function one(key: string, blocks: BlockOrNone): KeyedBlock[] {
  return blocks.map((block) => keyed(block, key));
}
function each(key: string, blocks: Block[]): KeyedBlock[] {
  return blocks.map((block, index) => keyed(block, `${key}.${index}`));
}
// The blocks of one content block of a message: the one block keeps the content block's key, so a text nothing was
// injected into is keyed as it always was, and a text split into several is keyed by the place of each piece in it.
function contentBlocks(key: string, blocks: Block[]): KeyedBlock[] {
  return blocks.length === 1 ? blocks.map((block) => keyed(block, key)) : each(key, blocks);
}
// Blocks standing at `place` in their thread.
function placed(place: Place, blocks: KeyedBlock[]): KeyedBlock[] {
  return blocks.map((block) => ({ ...block, place }));
}
// The blocks of a message's content, in `role`, at `place`: as a request sends it, and as a response replies, the same.
function messageContent(content: unknown[], role: Role, place: Place): KeyedBlock[] {
  return placed(place, content.flatMap((block, index) => contentBlocks(`content.${index}`, formatContent(block, role))));
}

// The Messages API's exchanges; requests to other paths, and to a target that is no URL, are forwarded and not shown
// (F2). One whose request was not recorded is shown, since its path is not known.
function isMessages({ request: { head } }: Exchange): boolean {
  return head === undefined || (head.method === "POST" && URL.parse(head.url, "http://proxy")?.pathname === "/v1/messages");
}

function requestShown(sides: Sides, side: RequestSide): RequestShown {
  const { head } = side;
  const trailers = trailersOf(side);
  const { body, whole } = sides.decode(side);
  const http = head === undefined ? notRecorded("request") : httpBlock("HTTP request", `${head.method} ${head.url} HTTP/${head.http_version}`, head.headers, trailers);
  const { own, ...sent } = requestBody(body.text, whole);
  return { own: [...one("http", [http]), ...one("undecoded", undecoded(body)), ...own], ...sent };
}


// The request body: its parameters and its cache breakpoints, which stand with the exchange's own; what it sends, its
// tool definitions, its system prompt and each message; and the model and the session among its parameters.
// [LAW:one-source-of-truth] A request sends a place when it has the place's group (view/history.ts), so a whole body has
// its tools' and its system prompt's groups whether or not it sends any.
function requestBody(text: string, whole: boolean): RequestShown {
  if (!whole) return { own: one("body", leftover("request body so far", text)), sent: [], messages: 0, ...unsaid };
  return attempt(
    () => {
      const { value: body, unread } = readShown(requestFields, parseJson(text, "request body"), "request body");
      // [LAW:one-source-of-truth] A cache breakpoint is the request's, not the block it is set on: the cache's prefix is
      // built from the tools, then the system prompt, then the messages, and Claude Code moves the breakpoints to the
      // newest blocks on every request, so a block left holding one would differ each time it is resent. They are
      // lifted out of the blocks in that order, into one block of the request's own.
      const breakpoints: Field[] = [];
      // A tool's breakpoint is named by its block's key, as every other block's is.
      const tools = toolBlocks(lift(body.tools, (index, list) => toolKeys(list)[index]!, breakpoints));
      const system = systemBlocks(lift(body.system, (index) => `system.${index}`, breakpoints));
      // Each message at its place: a speaker's numbered among the speakers', a system-role one among those standing
      // before the same speaker's message.
      let speakers = 0;
      let standing = 0;
      const messages = body.messages.map((message) => {
        const system = speakerOf(message, []).value.role === "system";
        const key = system ? `message.${speakers}.system.${standing}` : `message.${speakers}`;
        const place: Place = system ? { in: "system message", before: speakers, index: standing } : { in: "message", index: speakers };
        standing = system ? standing + 1 : 0;
        speakers += system ? 0 : 1;
        return messageGroup(liftContent(message, key, breakpoints), key, place);
      });
      // Every other field is a parameter, so one the API adds is shown with the rest; the model stays among them. Its line
      // previews those a client varies from one request to the next.
      const rest = unreadFields(unread);
      const parameters: Block = { category: "parameters", name: "parameters", parts: [valuePart(rest, "parameters")], preview: [pickedPart(rest, varied)] };
      // Its line previews where they are.
      const places: PartBody = { kind: "text", form: "verbatim", text: breakpoints.map(([place]) => place).join("  ") };
      const cache: BlockOrNone =
        breakpoints.length === 0 ? [] : [{ category: "parameters", name: `cache breakpoints: ${breakpoints.length}`, parts: [{ id: "breakpoints", kind: "fields", fields: breakpoints }], preview: [places] }];
      const { model, metadata } = requestFacts(rest, []).value;
      return {
        own: [...placed({ in: "parameters" }, one("parameters", [parameters])), ...one("cache", cache)],
        sent: [
          { key: "tools", title: "tools", blocks: placed({ in: "tools" }, tools) },
          { key: "system", title: "system", blocks: placed({ in: "system" }, each("system", system)) },
          ...messages,
        ],
        messages: speakers,
        model,
        session: sessionOf(metadata?.user_id),
      };
    },
    (reason) => ({ own: one("body", [raw("http", "request body", reason, { kind: "text", form: "verbatim", text })]), sent: [], messages: 0, ...unsaid }),
  );
}

const str = value(kinds.string);

// What a request body sends, each read by what shows it; every other field of it is a parameter.
const requestFields = object({ tools: rawValue, system: rawValue, messages: value(kinds.list) });

// [LAW:one-source-of-truth] What a request's parameters state, each read on its own from its own field, so one that does
// not read leaves the request shown whole, that field among its parameters.
const requestFacts = tolerant<{ model?: string; metadata?: { user_id?: string } }>({ model: str, metadata: tolerant<{ user_id?: string }>({ user_id: str }, {}) }, {});

// The session a request's metadata names: Claude Code's `user_id` is the JSON text of an object holding `session_id`
// (seen on Claude Code's traffic, 2026-11-16; the format is not documented). The API takes any string as a user's id, so
// one of another client's, or of any other shape, names none, and is shown among the parameters as it was sent.
function sessionOf(userId: string | undefined): string | undefined {
  if (userId === undefined) return undefined;
  return attempt(
    () => parse(object({ session_id: str }), parseJson(userId, "user_id"), "user_id").session_id,
    () => undefined,
  );
}
// A list of blocks with each block's cache breakpoint taken out, and added to `breakpoints` with the place `at` names. A
// value that is not a list, or a block that is not an object, holds no breakpoint, and is left for its reader to show.
function lift(list: unknown, at: (index: number, list: unknown[]) => string, breakpoints: Field[]): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((block: unknown, index) => {
    if (typeof block !== "object" || block === null || !("cache_control" in block)) return block;
    const { cache_control: breakpoint, ...rest } = block;
    breakpoints.push([at(index, list), fieldValue(breakpoint)]);
    return rest;
  });
}
function liftContent(message: unknown, at: string, breakpoints: Field[]): unknown {
  if (typeof message !== "object" || message === null || !("content" in message)) return message;
  return { ...message, content: lift(message.content, (index) => `${at}/content.${index}`, breakpoints) };
}

// The parameters a client varies from one request to the next, which a request's parameters line previews: the model,
// how many tokens it may write, how it thinks and with what effort, and how it samples.
const varied = ["model", "max_tokens", "thinking", "output_config.effort", "temperature"];

const role = value(kinds.among(Object.keys(roleCategory) as Role[]));
// Who a message speaks as, read on its own, so a message whose role does not read still stands at its place.
const speakerOf = tolerant<{ role?: Role }>({ role }, {});
const sentMessage = object({ role, content: optional(rawValue) });

// A message as its group: its blocks, and its fields no read asked for. [LAW:no-silent-failure] One whose role does not
// read is shown raw, as a message; one whose content does not read keeps its role and its fields, its content shown raw,
// with why.
function messageGroup(message: unknown, key: string, place: Place): Group {
  return attempt(
    (): Group => {
      const { value, unread } = readShown(sentMessage, message, "message");
      const content = attempt(
        () => messageContent(blocksOf(value.content, "content"), value.role, place),
        (reason) => placed(place, one("content", [raw("http", "message content", reason, { kind: "json", value: value.content })])),
      );
      return { key, title: value.role, blocks: [...content, ...placed(place, one("fields", restBlock(unread, "parameters", "message")))] };
    },
    (reason) => ({ key, title: "message", blocks: placed(place, one("message", [raw("http", "message", reason, { kind: "json", value: message })])) }),
  );
}

// A message's content, or a system prompt: a string, the text of one text block, or a list of blocks.
function blocksOf(content: unknown, what: string): unknown[] {
  if (content === undefined) throw new Malformed(`${what}: is missing`);
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) throw new Malformed(`${what}: is neither a string nor a list of blocks`);
  return blocks;
}

function systemBlocks(system: unknown): Block[] {
  if (system === undefined) return [];
  return blocksOf(system, "system").map((block) => formatBlock(block, "system", "markdown"));
}

// Each tool definition as a block of its own, named for its tool, its description read first and its schema after.
// [LAW:types-are-the-program] Keyed by its name, `tools.<name>.<n>`, `n` its occurrence among tools of that name, so a
// tool is the same item in every request that offers it wherever it stands in the list (view/history.ts), and the key
// is unique and has no `/` (view/position.ts) whatever a recorded request holds. A tool that does not fit is shown raw.
function toolBlocks(tools: unknown): KeyedBlock[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new Malformed("tools: is not a list");
  const keys = toolKeys(tools);
  return tools.map((tool, index) => keyed(toolBlock(tool), keys[index]!));
}

// Each tool's key, its name's `%` and `/` escaped as a URI's are.
function toolKeys(tools: unknown[]): string[] {
  const names = tools.map((tool) => toolNaming(tool).name);
  const counted = occurrences(names, (name) => name);
  return names.map((name, index) => `tools.${name.replaceAll("%", "%25").replaceAll("/", "%2F")}.${counted[index]}`);
}

// [LAW:single-enforcer] What names a tool, the one rule its key and its block's name follow: a client tool's name; a
// server tool's type, which names it when it has no name; and `tool` for one that names none. `by`: the field it is
// named by, which its block does not show again among the rest.
const naming = tolerant<{ name?: string; type?: string }>({ name: str, type: str }, {});
function toolNaming(tool: unknown): { name: string; by: keyof typeof described } {
  const { name, type } = naming(tool, []).value;
  return name !== undefined ? { name, by: "name" } : type !== undefined ? { name: type, by: "type" } : { name: "tool", by: "none" };
}
const description = optional(str);
const described = {
  name: mapped(object({ description, name: str }), (tool) => tool.description),
  type: mapped(object({ description, type: str }), (tool) => tool.description),
  none: mapped(object({ description }), (tool) => tool.description),
};

function toolBlock(tool: unknown): Block {
  const { name, by } = toolNaming(tool);
  return attempt(
    (): Block => {
      const { value: description, unread } = readShown(described[by], tool, "tool definition");
      return {
        category: "tools",
        name,
        parts: [...(description === undefined ? [] : [{ id: "description", kind: "text", form: "markdown", text: description } as const]), ...unreadParts(unread)],
      };
    },
    (reason) => raw("tools", name, reason, { kind: "json", value: tool }),
  );
}

// The response's blocks, up to how its exchange ended, and its message's facts.
function responseShown(sides: Sides, side: ResponseSide): ResponseShown {
  const { head } = side;
  const trailers = trailersOf(side);
  const { body, whole } = sides.decode(side);
  // A response that has not begun has no head to miss.
  const http: BlockOrNone =
    head === undefined
      ? latest(side) === undefined
        ? []
        : [notRecorded("response")]
      : [httpBlock("HTTP response", `HTTP/${head.http_version} ${statusText(head)}`, head.headers, trailers)];
  const { own, ...read } = responseBody(sides, side, body, whole);
  return { own: [...one("http", http), ...one("undecoded", undecoded(body)), ...own], ...read };
}

// The response body: a stream reassembled into its message; once whole, a message or an error; anything else raw.
function responseBody(sides: Sides, side: ResponseSide, body: Body, whole: boolean): ResponseShown {
  const { text } = body;
  if (headerValues(side.head?.headers ?? [], "content-type")[0]?.toLowerCase().startsWith("text/event-stream")) {
    const stream = sides.reassemble(side, body);
    // The text after the last complete event is the event still arriving until the side is complete, and only then
    // left over, as a stream cut short leaves it: shown earlier, it would come and go as each frame's bytes end.
    const tail = side.completedBy === undefined ? "" : stream.tail;
    const { own, reply, message } = stream.message === undefined ? none([]) : messageBlocks(stream.message);
    const fields = stream.fields.map((block) => keyed(block, `fields/${block.name}`));
    return { own: [...own, ...each("event", stream.blocks), ...fields, ...one("tail", leftover("stream tail", tail))], reply: [...reply, ...each("error", stream.errors)], message };
  }
  if (!whole) return none(one("body", leftover("response body so far", text)));
  return attempt(
    (): ResponseShown => {
      const body = parseJson(text, "response body");
      const { type } = parse(replyType, body, "response body");
      switch (type) {
        case "message":
          return messageBlocks(body);
        case "error": {
          const { value, unread } = readShown(errorBody, body, "response body");
          return { ...none([]), reply: one("error", [formatError(value.error, unread)]) };
        }
        default:
          return type satisfies never;
      }
    },
    (reason) => none(one("body", [raw("http", "response body", reason, { kind: "text", form: "verbatim", text })])),
  );
}

const replyType = object({ type: value(kinds.among(["message", "error"] as const)) });
const errorBody = object({ type: rawValue, error: rawValue });

// A response no message was read from: the blocks that are its exchange's own, and no reply.
const none = (own: KeyedBlock[]): ResponseShown => ({ own, reply: [], message: noMessage });

// A response message as it is shown: its content, and what the API reported, shown as it was sent.
const messageFields = object({ type: rawValue, content: value(kinds.list), stop_reason: rawValue, stop_sequence: rawValue, usage: rawValue });
// [LAW:one-source-of-truth] What a response message states, each read on its own from its own field: why it stopped, and
// each count of its usage, so one that does not read is none and the rest stand, each shown as it was sent.
const count = value(kinds.number);
const messageFacts = tolerant<{ stop_reason?: string; usage?: Partial<Record<"input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens" | "output_tokens", number>> }>(
  { stop_reason: str, usage: tolerant({ input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count }, {}) },
  {},
);

// A response message: its content, which is the reply; what the API reported about it, which is the exchange's own;
// and, of what it reported, the facts.
function messageBlocks(message: unknown): ResponseShown {
  return attempt(
    (): ResponseShown => {
      const { value: fields, unread } = readShown(messageFields, message, "message");
      const reply = messageContent(fields.content, "assistant", { in: "reply" });
      const stop = { stop_reason: fields.stop_reason, stop_sequence: fields.stop_sequence };
      const { usage } = fields;
      const { stop_reason, usage: counts = {} } = messageFacts(message, []).value;
      return {
        reply,
        own: [
          // The stop reason is the line's name; the stop sequence, when one stopped it, is its preview.
          ...one("stop reason", [
            {
              category: "usage",
              name: `stop reason: ${show(fields.stop_reason)}`,
              parts: [{ id: "stop", ...pickedPart(stop, ["stop_reason", "stop_sequence"]) }],
              preview: [pickedPart(stop, ["stop_sequence"])],
            },
          ]),
          ...one("usage", [{ category: "usage", name: "usage", parts: [valuePart(usage, "usage")], preview: [pickedPart(usage, counted)] }]),
          // Of what else the API reported, the line previews the message's id, which is all of it that varies.
          ...one("fields", restBlock(unread, "usage", "message")).map((block) => ({ ...block, preview: [pickedPart(unreadFields(unread), ["id"])] })),
        ],
        message: {
          uncached: counts.input_tokens,
          cacheRead: counts.cache_read_input_tokens,
          cacheWritten: counts.cache_creation_input_tokens,
          output: counts.output_tokens,
          stopReason: stop_reason,
        },
      };
    },
    (reason) => none(one("message", [raw("http", "message", reason, { kind: "json", value: message })])),
  );
}

// The counts a usage line previews: the tokens read, uncached, from the cache and written to it, and written out, of which
// the thinking's.
const counted = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens", "output_tokens_details.thinking_tokens"];

// How an exchange ended, as the block it adds, to the reply or to the exchange's own: none for one that completed or
// has not ended.
type Ending = { own: BlockOrNone; reply: BlockOrNone };
function ending(end: Of<"end"> | undefined): Ending {
  const cut = (name: string, text: string): Ending => ({ own: [{ category: "http", name, parts: [{ id: "end", kind: "text", form: "verbatim", text }] }], reply: [] });
  switch (end?.outcome) {
    case undefined:
    case "ok":
      return { own: [], reply: [] };
    // A failure stands where the reply would have been, as an error the API returned does.
    case "error":
      return { own: [], reply: [{ category: "assistant", name: "error", parts: [{ id: "error", kind: "text", form: "verbatim", text: end.error }] }] };
    case "aborted":
      return cut("aborted", "The agent left the exchange before it completed.");
    case "stopped":
      return cut("stopped", "The proxy stopped before the exchange completed.");
  }
}

function httpBlock(name: string, line: string, headers: Header[], trailers: { headers: Header[] } | undefined): Block {
  const trailerParts = trailers === undefined || trailers.headers.length === 0 ? [] : [{ id: "trailers", label: "trailers", kind: "fields" as const, fields: trailers.headers }];
  return { category: "http", name, parts: [{ id: "line", kind: "text", form: "verbatim", text: line }, { id: "headers", label: "headers", kind: "fields", fields: headers }, ...trailerParts] };
}

function notRecorded(side: "request" | "response"): Block {
  return { category: "http", name: `HTTP ${side}`, parts: [{ id: "head", kind: "text", form: "verbatim", text: `The ${side}'s head was not recorded, and with it its content type and coding.` }] };
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
  return body.error === undefined ? [] : [{ category: "http", name: "body not decoded", parts: [{ id: "error", kind: "text", form: "verbatim", text: body.error }] }];
}
function leftover(name: string, text: string): BlockOrNone {
  return text === "" ? [] : [{ category: "http", name, parts: [{ id: "text", kind: "text", form: "verbatim", text }] }];
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "undefined";
}
