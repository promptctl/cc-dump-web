import { encoded, fieldOf, held, kinds, nullable, object, optional, raw, value, type Held, type Path, type Reader } from "@cc-dump/log/json";
import { statusText } from "@cc-dump/log/status";
import type { Header } from "@cc-dump/proxy/format";
import { latest, trailersOf, type Exchange, type ExchangeShown, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { equal } from "./equal.ts";
import { errorBlock, formatBlock, formatContent, refusedBlock, roleCategory, roles, unreadBlock, unreadParts, type Block, type BlockOrNone, type Role } from "./blocks.ts";
import { fieldValue, notSent, occurrences, pickedPart, valuePart, type Field, type Part, type PartBody } from "./parts.ts";
import { senderOf, type Sender } from "./wire.ts";
import { createReassembly, type Built, type Reassembly, type Stream } from "./stream.ts";

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
// message at `index` among those a speaker sent, the user or the assistant; in a message no speaker sent, a
// system-role one or one whose role does not read, the one at `index` among those standing before the speakers' message
// `before`; or in the reply, the message the response adds after the request's. [LAW:types-are-the-program] A place is
// where a block stands in the conversation, not in the request's list: Claude Code sends system-role messages among the
// others and leaves a trailing one out of the next request, which moves no speaker's message. A block with no place is
// the exchange's own, as its HTTP, its cache breakpoints and its usage are.
export type Place =
  | { in: "parameters" }
  | { in: "tools" }
  | { in: "system" }
  | { in: "message"; index: number }
  | { in: "between"; before: number; index: number }
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
// events arrive, so a response read while it streams costs what arrives, not its whole length each time, and a block
// of it that has stopped is formatted once.
export function createFormatter(): (exchanges: Exchange[]) => FormattedExchange[] {
  const requests = new WeakMap<object, RequestShown>();
  const responses = new WeakMap<object, ResponseShown>();
  const formatted = new WeakMap<object, FormattedExchange>();
  const decodings = new WeakMap<object, Decoding>();
  const reassemblies = new WeakMap<object, Reassembly>();
  const replies = new WeakMap<Built, KeyedBlock[]>();
  const intern = createInterning();
  const sides: Sides = {
    decode: (side) => decodeSide(growing(decodings, side, () => createDecoding(side.head?.headers ?? [])), side),
    reassemble: (side, body) => growing(reassemblies, side, createReassembly).reassemble(body.text, side.completedBy !== undefined),
    reply: (built, index) => cached(replies, built, () => replyContent(built, index)),
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

// The decoding of each side's body and the reassembly of each streamed response, kept as they grow, and the blocks of
// each content block of a reply, kept with it.
type Sides = {
  decode: (side: RequestSide | ResponseSide) => { body: Body; whole: boolean };
  reassemble: (side: ResponseSide, body: Body) => Stream;
  reply: (built: Built, index: number) => KeyedBlock[];
};

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

function cached<K extends object, T>(cache: WeakMap<K, T>, key: K, compute: () => T): T {
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
// The blocks of a request message's content, in `role`, at `at`.
function messageContent(content: unknown[], role: Role, at: Path): KeyedBlock[] {
  return content.flatMap((block, index) => contentBlocks(`content.${index}`, formatContent(block, role, [...at, String(index)])));
}
// The blocks of a reply's content block, at `index` in its message's content, as a request resends it but for one its
// message stopped before it did, whose last block says it was cut.
function replyContent({ block, cut }: Built, index: number): KeyedBlock[] {
  const blocks = formatContent(block, "assistant", ["content", String(index)]);
  const cutPart: Part = { id: "cut", kind: "text", form: "verbatim", text: "The message stopped before this block did." };
  const shown = cut ? blocks.map((one, at) => (at === blocks.length - 1 ? { ...one, parts: [...one.parts, cutPart] } : one)) : blocks;
  return placed({ in: "reply" }, contentBlocks(`content.${index}`, shown));
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

// [LAW:parse-dont-validate] A body's text as the JSON object it holds.
const bodyObject: Reader<Record<string, unknown>> = (text, at) => value(kinds.object)(encoded(text, at).value, at);
// What a request sends beside its parameters, each read on its own: its system prompt, its tools and its messages.
const requestFields = object({ system: raw, tools: raw, messages: raw });
// A system prompt's or a message's content: its text, or its content blocks.
const content = value<string | unknown[]>({ fits: (json): json is string | unknown[] => typeof json === "string" || Array.isArray(json), expected: "a string or a list of blocks" });

// The request body: its parameters and its cache breakpoints, which stand with the exchange's own; what it sends, its
// tool definitions, its system prompt and each message, each read on its own, so one that does not read is shown as
// received, with why, beside the others; and the model and the session among its parameters.
// [LAW:one-source-of-truth] A request sends a place when it has the place's group (view/history.ts), so a whole body has
// its tools' and its system prompt's groups whether or not it sends any.
function requestBody(text: string, whole: boolean): RequestShown {
  if (!whole) return { own: one("body", leftover("request body so far", text)), sent: [], messages: 0, ...unsaid };
  const body = held(bodyObject)(text, []).value;
  if (body.is === "refused") return { own: one("body", [refusedBlock("http", "request body", body.refusals, { kind: "text", form: "verbatim", text })]), sent: [], messages: 0, ...unsaid };
  // Every field but those it sends is a parameter, so one the API adds is shown with the rest; the model stays among
  // them. Its line previews those a client varies from one request to the next.
  const { value: sends, unknown } = requestFields(body.value, []);
  const parameters = Object.fromEntries(unknown.map(({ at, value }) => [at[0]!, value]));
  // [LAW:one-source-of-truth] A cache breakpoint is the request's, not the block it is set on: the cache's prefix is
  // built from the tools, then the system prompt, then the messages, and Claude Code moves the breakpoints to the
  // newest blocks on every request, so a block left holding one would differ each time it is resent. They are lifted
  // out of the blocks in that order, into one block of the request's own.
  const breakpoints: Field[] = [];
  // A tool's breakpoint is named by its block's key, as every other block's is.
  const tools = toolBlocks(lift(sends.tools, (index, list) => toolKeys(list)[index]!, breakpoints));
  const system = systemBlocks(lift(sends.system, (index) => `system.${index}`, breakpoints));
  const messages = messageGroups(sends.messages, breakpoints);
  const block: Block = { category: "parameters", name: "parameters", parts: [valuePart(parameters, "parameters")], preview: [pickedPart(parameters, varied)] };
  // Its line previews where they are.
  const places: PartBody = { kind: "text", form: "verbatim", text: breakpoints.map(([place]) => place).join("  ") };
  const cache: BlockOrNone =
    breakpoints.length === 0 ? [] : [{ category: "parameters", name: `cache breakpoints: ${breakpoints.length}`, parts: [{ id: "breakpoints", kind: "fields", fields: breakpoints }], preview: [places] }];
  const model = fieldOf(parameters, "model");
  return {
    own: [...placed({ in: "parameters" }, one("parameters", [block])), ...one("cache", cache), ...messages.own],
    sent: [{ key: "tools", title: "tools", blocks: placed({ in: "tools" }, tools) }, { key: "system", title: "system", blocks: placed({ in: "system" }, system) }, ...messages.groups],
    messages: messages.speakers,
    model: kinds.string.fits(model) ? model : undefined,
    session: sessionOf(fieldOf(parameters, "metadata")),
  };
}

// The session a request's metadata names: Claude Code's `user_id` is the JSON text of an object holding `session_id`
// (seen on Claude Code's traffic, 2026-11-16; the format is not documented). Metadata of any other shape names none.
function sessionOf(metadata: unknown): string | undefined {
  const userId = fieldOf(metadata, "user_id");
  const user = kinds.string.fits(userId) ? held(encoded)(userId, ["metadata", "user_id"]).value : undefined;
  const session = user?.is === "read" ? fieldOf(user.value, "session_id") : undefined;
  return kinds.string.fits(session) ? session : undefined;
}

// A list of blocks with each block's cache breakpoint taken out, and added to `breakpoints` with the place `at` names. A
// value that is not a list, or a block that is not an object, holds no breakpoint, and is left for its reader to show.
function lift(list: unknown, at: (index: number, list: unknown[]) => string, breakpoints: Field[]): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((block: unknown, index) => {
    if (!kinds.object.fits(block) || !Object.hasOwn(block, "cache_control")) return block;
    breakpoints.push([at(index, list), fieldValue(block.cache_control)]);
    return Object.fromEntries(Object.entries(block).filter(([field]) => field !== "cache_control"));
  });
}

// The parameters a client varies from one request to the next, which a request's parameters line previews: the model,
// how many tokens it may write, how it thinks and with what effort, and how it samples.
const varied = ["model", "max_tokens", "thinking", "output_config.effort", "temperature"];

// Each message at its place, its content's breakpoints lifted: a speaker's numbered among the speakers', one no speaker
// sent, a system-role one or one whose role does not read, among those standing before the next speaker's message.
// Messages that are no list are shown as received, with why, among the request's own blocks.
const role = value(kinds.among(roles));
function messageGroups(sent: unknown, breakpoints: Field[]): { own: KeyedBlock[]; groups: Group[]; speakers: number } {
  const messages = held(value(kinds.list))(sent, ["messages"]).value;
  if (messages.is === "refused") return { own: one("messages", [refusedBlock("http", "messages", messages.refusals, { kind: "json", value: sent })]), groups: [], speakers: 0 };
  let speakers = 0;
  let standing = 0;
  const groups = messages.value.map((message, index) => {
    const at = ["messages", String(index)];
    const said = held(role)(fieldOf(message, "role"), [...at, "role"]).value;
    const speaker = said.is === "read" && said.value !== "system";
    const key = speaker ? `message.${speakers}` : `message.${speakers}.system.${standing}`;
    const place: Place = speaker ? { in: "message", index: speakers } : { in: "between", before: speakers, index: standing };
    standing = speaker ? 0 : standing + 1;
    speakers += speaker ? 1 : 0;
    return messageGroup(liftContent(message, key, breakpoints), key, place, at);
  });
  return { own: [], groups, speakers };
}
function liftContent(message: unknown, at: string, breakpoints: Field[]): unknown {
  if (!kinds.object.fits(message) || !Object.hasOwn(message, "content")) return message;
  return { ...message, content: lift(message.content, (index) => `${at}/content.${index}`, breakpoints) };
}

// A message, at `at`: its role's blocks of its content, and its other fields. A message whose role does not read is no
// speaker's, and is shown as received, with why; one whose content does not read keeps its role and its other fields.
const message = object({ role, content: held(content) });
function messageGroup(sent: unknown, key: string, place: Place, at: Path): Group {
  const read = held(message)(sent, at);
  if (read.value.is === "refused") return { key, title: "message", blocks: placed(place, one("message", [refusedBlock("http", "message", read.value.refusals, { kind: "json", value: sent })])) };
  const { role, content } = read.value.value;
  const blocks =
    content.is === "refused"
      ? one("content", [refusedBlock(roleCategory[role], "content", content.refusals, { kind: "json", value: content.sent })])
      : messageContent(typeof content.value === "string" ? [{ type: "text", text: content.value }] : content.value, role, [...at, "content"]);
  return { key, title: role, blocks: placed(place, [...blocks, ...one("fields", unreadBlock(read.unknown, at, "parameters", "message"))]) };
}

// The system prompt's blocks: a string is the text of one text block. One that does not read is shown as received,
// with why.
function systemBlocks(sent: unknown): KeyedBlock[] {
  const system = held(optional(content))(sent, ["system"]).value;
  if (system.is === "refused") return one("system", [refusedBlock("system", "system", system.refusals, { kind: "json", value: sent })]);
  if (system.value === undefined) return [];
  if (typeof system.value === "string") return each("system", [formatBlock({ type: "text", text: system.value }, "system", "markdown", ["system"])]);
  return each(
    "system",
    system.value.map((block, index) => formatBlock(block, "system", "markdown", ["system", String(index)])),
  );
}

// Each tool definition as a block of its own, named for its tool, its description read first and its schema after.
// [LAW:types-are-the-program] Keyed by its name, `tools.<name>.<n>`, `n` its occurrence among tools of that name, so a
// tool is the same item in every request that offers it wherever it stands in the list (view/history.ts), and the key
// is unique and has no `/` (view/position.ts) whatever a recorded request holds. Tools that are no list, and a tool
// that does not read, are shown as received, with why.
function toolBlocks(sent: unknown): KeyedBlock[] {
  const tools = held(optional(value(kinds.list)))(sent, ["tools"]).value;
  if (tools.is === "refused") return one("tools", [refusedBlock("tools", "tools", tools.refusals, { kind: "json", value: sent })]);
  if (tools.value === undefined) return [];
  const keys = toolKeys(tools.value);
  return tools.value.map((tool, index) => keyed(toolBlock(tool, toolName(tool), ["tools", String(index)]), keys[index]!));
}

// Each tool's key, its name's `%` and `/` escaped as a URI's are.
function toolKeys(tools: unknown[]): string[] {
  const names = tools.map(toolName);
  const counted = occurrences(names, (name) => name);
  return names.map((name, index) => `tools.${name.replaceAll("%", "%25").replaceAll("/", "%2F")}.${counted[index]}`);
}

// A tool definition: its description, and its other fields; the field it is named for, its name or, for a server tool
// with none, its type, read so it is not shown again among them.
const text = value(kinds.string);
const namedTool = object({ name: text, description: optional(text) });
const typedTool = object({ type: optional(text), description: optional(text) });
function toolBlock(tool: unknown, name: string, at: Path): Block {
  const read = held<{ description: string | undefined }>(fieldOf(tool, "name") === undefined ? typedTool : namedTool)(tool, at);
  if (read.value.is === "refused") return refusedBlock("tools", name, read.value.refusals, { kind: "json", value: tool });
  const { description } = read.value.value;
  return { category: "tools", name, parts: [...(description === undefined ? [] : [{ id: "description", kind: "text", form: "markdown", text: description } as const]), ...unreadParts(read.unknown, at)] };
}

// A client tool's name; a server tool's type, which names it when it has no name.
function toolName(tool: unknown): string {
  return [fieldOf(tool, "name"), fieldOf(tool, "type")].find(kinds.string.fits) ?? "tool";
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

// What a whole response body is, by its type: a message, or an error the API returned.
const kind = value(kinds.among(["message", "error"]));
const apiError = object({ type: raw, error: value(kinds.object) });

// The response body: a stream reassembled into its message; once whole, a message or an error; anything else as
// received, with why.
function responseBody(sides: Sides, side: ResponseSide, body: Body, whole: boolean): ResponseShown {
  const { text } = body;
  if (headerValues(side.head?.headers ?? [], "content-type")[0]?.toLowerCase().startsWith("text/event-stream")) {
    const stream = sides.reassemble(side, body);
    // The text after the last complete event is the event still arriving until the side is complete, and only then
    // left over, as a stream cut short leaves it: shown earlier, it would come and go as each frame's bytes end.
    const tail = side.completedBy === undefined ? "" : stream.tail;
    const { own, reply, message } = stream.message === undefined ? none([]) : messageBlocks(sides, stream.message, { is: "read", value: stream.content });
    const fields: BlockOrNone = stream.fields.length === 0 ? [] : [{ category: "http", name: "event fields", parts: [{ id: "fields", label: "fields", kind: "rest", fields: stream.fields }] }];
    return {
      own: [...own, ...one("event fields", fields), ...each("event", stream.refused), ...one("tail", leftover("stream tail", tail))],
      reply: [...reply, ...each("error", stream.errors)],
      message,
    };
  }
  if (!whole) return none(one("body", leftover("response body so far", text)));
  const received = (refusals: Held<unknown> & { is: "refused" }) => none(one("body", [refusedBlock("http", "response body", refusals.refusals, { kind: "text", form: "verbatim", text })]));
  const read = held(bodyObject)(text, []).value;
  if (read.is === "refused") return received(read);
  const type = held(kind)(fieldOf(read.value, "type"), ["type"]).value;
  if (type.is === "refused") return received(type);
  if (type.value === "message") {
    const content = held(value(kinds.list))(fieldOf(read.value, "content"), ["content"]).value;
    return messageBlocks(sides, read.value, content.is === "read" ? { is: "read", value: content.value.map((block) => ({ block, cut: false })) } : content);
  }
  const error = held(apiError)(read.value, []);
  return error.value.is === "read" ? { ...none([]), reply: one("error", [errorBlock(error.value.value.error, unreadParts(error.unknown, []))]) } : received(error.value);
}

// A response no message was read from: the blocks that are its exchange's own, and no reply.
const none = (own: KeyedBlock[]): ResponseShown => ({ own, reply: [], message: noMessage });

// [LAW:types-are-the-program] What the API reported about its message, each read on its own, so one that does not
// read costs only its own block: why it stopped, and what it counted, the counts the facts take read too.
const count = optional(nullable(value(kinds.integer)));
const counts = object({ input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count });
const reported = object({ type: raw, content: raw, stop_reason: held(optional(nullable(text))), stop_sequence: raw, usage: raw });

// A response message, its fields as a whole response or a stream's events built them, and its content: its content,
// which is the reply; what the API reported about it, which is the exchange's own; and, of what it reported, the facts.
function messageBlocks(sides: Sides, message: Record<string, unknown>, content: Held<Built[]>): ResponseShown {
  // Every field it declares is held or taken as it is, so the read is never refused.
  const { value: fields, unknown } = reported(message, []);
  const { stop_reason, stop_sequence, usage } = fields;
  const counted_ = held(optional(nullable(counts)))(usage, ["usage"]).value;
  const read = counted_.is === "read" ? counted_.value : undefined;
  const stop = { stop_reason: stop_reason.is === "read" ? stop_reason.value : stop_reason.sent, stop_sequence };
  const reply = content.is === "read" ? content.value.flatMap((built, index) => sides.reply(built, index)) : one("content", [refusedBlock("assistant", "content", content.refusals, { kind: "json", value: content.sent })]);
  return {
    reply,
    own: [
      // The stop reason is the line's name; the stop sequence, when one stopped it, is its preview.
      ...one("stop reason", [
        stop_reason.is === "read"
          ? {
              category: "usage",
              name: `stop reason: ${stop_reason.value === undefined ? notSent : String(stop_reason.value)}`,
              parts: [{ id: "stop", ...pickedPart(stop, ["stop_reason", "stop_sequence"]) }],
              preview: [pickedPart(stop, ["stop_sequence"])],
            }
          : refusedBlock("usage", "stop reason", stop_reason.refusals, { kind: "json", value: stop }),
      ]),
      ...one("usage", [
        counted_.is === "read"
          ? { category: "usage", name: "usage", parts: [valuePart(usage, "usage")], preview: [pickedPart(usage, counted)] }
          : refusedBlock("usage", "usage", counted_.refusals, { kind: "json", value: usage }),
      ]),
      // Of what else the API reported, the line previews the message's id, which is all of it that varies.
      ...one("fields", unreadBlock(unknown, [], "usage", "message")).map((block) => ({ ...block, preview: [pickedPart(message, ["id"])] })),
    ],
    message: {
      uncached: read?.input_tokens ?? undefined,
      cacheRead: read?.cache_read_input_tokens ?? undefined,
      cacheWritten: read?.cache_creation_input_tokens ?? undefined,
      output: read?.output_tokens ?? undefined,
      stopReason: stop_reason.is === "read" ? (stop_reason.value ?? undefined) : undefined,
    },
  };
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
