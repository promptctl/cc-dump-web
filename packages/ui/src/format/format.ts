import { fields, fromJsonText, held, kinds, list, object, optional, raw as asIs, readShown, refined, refusalOf, union, value, type Fields, type Readers, type Shown } from "@cc-dump/log/json";
import { statusText } from "@cc-dump/log/status";
import type { Header } from "@cc-dump/proxy/format";
import { latest, trailersOf, type Exchange, type ExchangeShown, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { equal } from "./equal.ts";
import { asSent, blocksOf, breakpoint, breakpointOf, breakpointsOf, contentOf, contents, formatBlock, formatContent, formatError, raw, roleCategory, roles, unreadBlock, unreadPart, type Block, type BlockOrNone, type Breakpoint, type Content, type Contents, type Role } from "./blocks.ts";
import { doesNotFit, fieldValue, occurrences, pickedPart, receivedParts, unreadParts, valuePart, type Field, type Part, type PartBody } from "./parts.ts";
import { senderOf, type Sender } from "./wire.ts";
import { messageFields, soFar, wholeReply, type EventField, type MessageFields, type Reply, type ReplyBlock } from "./reply.ts";
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
// the request sends, which is the reply's index among them, none where its messages did not read; and who sent it, by
// its head (format/wire.ts). Its exchange is as it stood when formatted, and holds no body.
export type FormattedExchange = { exchange: ExchangeShown; facts: Facts; groups: Group[]; messages: number | undefined; sender: Sender };

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
  // Each reply block's blocks, and each block of a stream's events keyed, made once: a stream's state keeps a block no
  // event changed the same object, and its events' blocks only grow at its end, so a block that arrived is the same
  // object as later events arrive, for the view's sizes and previews and the history's comparison.
  const replies = new WeakMap<object, KeyedBlock[]>();
  const events = new WeakMap<object, KeyedBlock>();
  const intern = createInterning();
  const sides: Sides = {
    decode: (side) => decodeSide(growing(decodings, side, () => createDecoding(side.head?.headers ?? [])), side),
    reassemble: (side, body) => growing(reassemblies, side, createReassembly).reassemble(body.text, side.completedBy !== undefined),
    reply: (block) => cached(replies, block, () => replyBlock(block)),
    keyed: (blocks, key) => blocks.map((block, index) => cached(events, block, () => keyed(block, `${key}.${index}`))),
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

// The decoding of each side's body and the reassembly of each streamed response, kept as they grow; a reply block's
// blocks, and a stream's event blocks keyed by `key`, made once.
type Sides = {
  decode: (side: RequestSide | ResponseSide) => { body: Body; whole: boolean };
  reassemble: (side: ResponseSide, body: Body) => Stream;
  reply: (block: ReplyBlock) => KeyedBlock[];
  keyed: (blocks: Block[], key: string) => KeyedBlock[];
};

// A request formatted: the blocks that are its exchange's own, the groups it sends, its tools, its system prompt and
// each message, how many of them are messages, the model it asks for and the session it is part of. A response
// formatted: the blocks that are its exchange's own, the reply's, and its message's facts.
type RequestShown = { own: KeyedBlock[]; sent: Group[]; messages: number | undefined } & Said;
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
function messageContent(content: readonly Content[], role: Role, place: Place): KeyedBlock[] {
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

// [LAW:types-are-the-program] A request body, read field by field: the model and the metadata its parameters say, and
// what it sends that the formatter arranges, its system prompt, its tools and its messages, each holding its own
// refusal, so one that does not read costs only itself and the request the rest of it.
type Tool = Breakpoint & { name?: string; type?: string; description?: string };
type Message = { role: Role; content: Contents };
type Metadata = { user_id?: { session: string | undefined } };
type Arranged = {
  system?: Shown<Contents>;
  tools?: Shown<readonly Shown<Fields<Tool>>[]>;
  messages?: Shown<readonly Shown<Fields<Message>>[]>;
};
type RequestFields = { model?: string; metadata?: Metadata } & Arranged;

const string = value(kinds.string);
// The session a request's metadata names: Claude Code's `user_id` is the JSON text of an object holding `session_id`
// (seen on Claude Code's traffic, 2026-11-16; the format is not documented). Any other text names none.
const session = fromJsonText(fields<{ session_id?: string }>({ session_id: optional(string) }));
const sessionIn = (text: string): string | undefined => {
  const read = readShown(session, text);
  return read.is === "read" ? read.read.value.value.session_id : undefined;
};
// [LAW:one-source-of-truth] What a request sends that the formatter arranges into groups of their own; every other
// field is a parameter.
const arranged: Readers<Arranged> = {
  system: optional(held(contents)),
  tools: optional(held(list(held(fields<Tool>({ ...breakpoint, name: optional(string), type: optional(string), description: optional(string) }))))),
  messages: optional(held(list(held(fields<Message>({ role: value(kinds.among(roles)), content: contents }))))),
};
const requestRead = fromJsonText(
  fields<RequestFields>({ model: optional(string), metadata: optional(object<Metadata>({ user_id: optional(refined(string, (text) => ({ session: sessionIn(text) }))) })), ...arranged }),
);

// What a request sends besides its parameters: its blocks, and the cache breakpoints they hold, each by its place.
type Sent = { blocks: KeyedBlock[]; breakpoints: Field[] };
const nothingSent: Sent = { blocks: [], breakpoints: [] };
// The breakpoints of a list of content blocks, each at the place `at` names by its index.
const breakpointsAt = (blocks: readonly Content[], at: (index: number) => string): Field[] =>
  blocks.flatMap((block, index) => breakpointOf(block).map((held): Field => [at(index), fieldValue(held)]));

// The request body: its parameters and its cache breakpoints, which stand with the exchange's own; what it sends, its
// tool definitions, its system prompt and each message; and the model and the session among its parameters.
// [LAW:one-source-of-truth] A request sends a place when it has the place's group (view/history.ts), so a whole body has
// its tools' and its system prompt's groups whether or not it sends any.
function requestBody(text: string, whole: boolean): RequestShown {
  if (!whole) return { own: one("body", leftover("request body so far", text)), sent: [], messages: undefined, ...unsaid };
  const shown = readShown(requestRead, text);
  if (shown.is === "refused") return { own: one("body", [raw("http", "request body", shown.why, { kind: "text", form: "verbatim", text })]), sent: [], messages: undefined, ...unsaid };
  const body = shown.read.value;
  const tools = toolBlocks(body.value.tools);
  const system = systemBlocks(body.value.system);
  const messages = messageGroups(body.value.messages);
  // The cache's prefix is built from the tools, then the system prompt, then the messages: the breakpoints' order.
  const breakpoints = [...tools.breakpoints, ...system.breakpoints, ...messages.breakpoints];
  // Every other field is a parameter, in the order sent, so one the API adds is shown with the rest; the model stays
  // among them. A parameter this view reads that does not read is said so, before them. Its line previews those a
  // client varies from one request to the next.
  const rest = Object.fromEntries(Object.entries(body.sent).filter(([key]) => !Object.hasOwn(arranged, key)));
  const misfit = body.refused.length === 0 ? [] : [doesNotFit(refusalOf(body.refused, []))];
  const parameters: Block = { category: "parameters", name: "parameters", parts: [...misfit, valuePart(rest, "parameters")], preview: [pickedPart(rest, varied)] };
  // Its line previews where they are.
  const places: PartBody = { kind: "text", form: "verbatim", text: breakpoints.map(([place]) => place).join("  ") };
  const cache: BlockOrNone =
    breakpoints.length === 0 ? [] : [{ category: "parameters", name: `cache breakpoints: ${breakpoints.length}`, parts: [{ id: "breakpoints", kind: "fields", fields: breakpoints }], preview: [places] }];
  return {
    own: [...placed({ in: "parameters" }, one("parameters", [parameters])), ...one("cache", cache), ...messages.own],
    sent: [{ key: "tools", title: "tools", blocks: placed({ in: "tools" }, tools.blocks) }, { key: "system", title: "system", blocks: placed({ in: "system" }, system.blocks) }, ...messages.groups],
    messages: messages.count,
    model: body.value.model,
    session: body.value.metadata?.user_id?.session,
  };
}

// The parameters a client varies from one request to the next, which a request's parameters line previews: the model,
// how many tokens it may write, how it thinks and with what effort, and how it samples.
const varied = [["model"], ["max_tokens"], ["thinking"], ["output_config", "effort"], ["temperature"]];

// A request's messages, each in its group at its place: a speaker's numbered among the speakers', a system-role one
// among those standing before the same speaker's message, and one that does not read as a speaker's. `count`: how many
// of a speaker's it sends, none where its messages did not read. A list that does not read is shown with the
// exchange's own, since it stands at no place.
type Messages = { groups: Group[]; own: KeyedBlock[]; breakpoints: Field[]; count: number | undefined };
function messageGroups(messages: Arranged["messages"]): Messages {
  if (messages === undefined) return { groups: [], own: [], breakpoints: [], count: undefined };
  if (messages.is === "refused") return { groups: [], own: one("messages", [raw("http", "messages", messages.why, { kind: "json", value: messages.sent })]), breakpoints: [], count: undefined };
  let speakers = 0;
  let standing = 0;
  const groups = messages.read.value.map((message) => {
    const system = message.is === "read" && message.read.value.value.role === "system";
    const key = system ? `message.${speakers}.system.${standing}` : `message.${speakers}`;
    const place: Place = system ? { in: "system message", before: speakers, index: standing } : { in: "message", index: speakers };
    standing = system ? standing + 1 : 0;
    speakers += system ? 0 : 1;
    return messageGroup(message, key, place);
  });
  return { groups: groups.map(({ group }) => group), own: [], breakpoints: groups.flatMap(({ breakpoints }) => breakpoints), count: speakers };
}

// A message, titled by its role, its content's blocks and its other fields at its place. One holding a field that does
// not read is shown as its raw JSON, with why, under its role where that read and as a message where it did not; the
// breakpoints its content holds are still the request's.
function messageGroup(message: Shown<Fields<Message>>, key: string, place: Place): { group: Group; breakpoints: Field[] } {
  const rawGroup = (title: Heading, category: Block["category"], why: string, sent: unknown): Group => ({ key, title, blocks: placed(place, one("message", [raw(category, "message", why, { kind: "json", value: sent })])) });
  if (message.is === "refused") return { group: rawGroup("message", "http", message.why, message.sent), breakpoints: [] };
  const { refused, sent, unread, value } = message.read.value;
  const blocks = value.content === undefined ? [] : blocksOf(value.content);
  const breakpoints = breakpointsAt(blocks, (index) => `${key}/content.${index}`);
  if (refused.length > 0) return { group: rawGroup(value.role ?? "message", value.role === undefined ? "http" : roleCategory[value.role], refusalOf(refused, []), sent), breakpoints };
  const role = value.role!;
  return { group: { key, title: role, blocks: [...messageContent(blocks, role, place), ...placed(place, one("fields", unreadBlock(unread, "parameters", "message")))] }, breakpoints };
}

// The system prompt's blocks, a string the text of one text block. One that does not read is shown as its raw JSON.
function systemBlocks(system: Arranged["system"]): Sent {
  if (system === undefined) return nothingSent;
  if (system.is === "refused") return { blocks: one("system", [raw("system", "system", system.why, { kind: "json", value: system.sent })]), breakpoints: [] };
  const blocks = blocksOf(system.read.value);
  return { blocks: each("system", blocks.map((block) => formatBlock(block, "system", "markdown"))), breakpoints: breakpointsAt(blocks, (index) => `system.${index}`) };
}

// Each tool definition as a block of its own, named for its tool, its description read first and its schema after.
// [LAW:types-are-the-program] Keyed by its name, `tools.<name>.<n>`, `n` its occurrence among tools of that name, so a
// tool is the same item in every request that offers it wherever it stands in the list (view/history.ts), and the key
// is unique and has no `/` (view/position.ts) whatever a recorded request holds, its name's `%` and `/` escaped as a
// URI's are. A tool's breakpoint is named by its block's key, as every other block's is. A list or a tool that does not
// read is shown raw.
function toolBlocks(tools: Arranged["tools"]): Sent {
  if (tools === undefined) return nothingSent;
  if (tools.is === "refused") return { blocks: one("tools", [raw("tools", "tools", tools.why, { kind: "json", value: tools.sent })]), breakpoints: [] };
  const list = tools.read.value;
  const names = list.map((tool) => (tool.is === "read" ? (tool.read.value.value.name ?? tool.read.value.value.type ?? "tool") : "tool"));
  const counted = occurrences(names, (name) => name);
  const keys = names.map((name, index) => `tools.${name.replaceAll("%", "%25").replaceAll("/", "%2F")}.${counted[index]}`);
  return {
    blocks: list.map((tool, index) => keyed(toolBlock(tool, names[index]!), keys[index]!)),
    breakpoints: list.flatMap((tool, index) => (tool.is === "read" ? breakpointsOf(tool.read.value.value).map((held): Field => [keys[index]!, fieldValue(held)]) : [])),
  };
}

// A tool's description, then its type where its name names it, then what else defines it. A server tool named by its
// type does not show it again.
function toolBlock(tool: Shown<Fields<Tool>>, name: string): Block {
  if (tool.is === "refused") return raw("tools", name, tool.why, { kind: "json", value: tool.sent });
  const read = tool.read.value;
  if (read.refused.length > 0) return raw("tools", name, refusalOf(read.refused, []), { kind: "json", value: asSent(read) });
  const { description, type } = read.value;
  const parts: Part[] = [
    ...(description === undefined ? [] : [{ id: "description", kind: "text", form: "markdown", text: description } satisfies Part]),
    ...(type === undefined || read.value.name === undefined ? [] : [{ id: "type", kind: "fields", fields: [["type", type]] } satisfies Part]),
    ...unreadParts(read.unread, [], unreadPart),
  ];
  return { category: "tools", name, parts };
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

// [LAW:types-are-the-program] A whole response body: a message, or an error the API returned.
const responseRead = fromJsonText(union<"type", { message: MessageFields; error: { error: unknown } }>("type", { message: messageFields, error: { error: asIs } }));

// The response body: a stream reassembled into its reply; once whole, a message or an error; anything else raw.
function responseBody(sides: Sides, side: ResponseSide, body: Body, whole: boolean): ResponseShown {
  const { text } = body;
  if (headerValues(side.head?.headers ?? [], "content-type")[0]?.toLowerCase().startsWith("text/event-stream")) {
    const stream = sides.reassemble(side, body);
    // The text after the last complete event is the event still arriving until the side is complete, and only then
    // left over, as a stream cut short leaves it: shown earlier, it would come and go as each frame's bytes end.
    const tail = side.completedBy === undefined ? "" : stream.tail;
    const { own, reply, message } = stream.reply.at === "before" ? none([]) : replyShown(sides, stream.reply.reply);
    return { own: [...own, ...sides.keyed(stream.blocks, "event"), ...one("tail", leftover("stream tail", tail))], reply: [...reply, ...sides.keyed(stream.errors, "error")], message };
  }
  if (!whole) return none(one("body", leftover("response body so far", text)));
  const shown = readShown(responseRead, text);
  if (shown.is === "refused") return none(one("body", [raw("http", "response body", shown.why, { kind: "text", form: "verbatim", text })]));
  const { tag, fields } = shown.read.value;
  // A message or an error holding a field that does not read is shown as its raw JSON, with why.
  if (fields.refused.length > 0) return none(one(tag, [raw("http", tag, refusalOf(fields.refused, []), { kind: "json", value: fields.sent })]));
  return tag === "message" ? replyShown(sides, wholeReply(fields)) : { ...none([]), reply: one("error", [formatError(fields.value.error, fields.unread)]) };
}

// A response no message was read from: the blocks that are its exchange's own, and no reply.
const none = (own: KeyedBlock[]): ResponseShown => ({ own, reply: [], message: noMessage });

// A reply: its content, which is the reply; what the API reported about it, which is the exchange's own; and, of what
// it reported, the facts.
function replyShown(sides: Sides, reply: Reply): ResponseShown {
  const { usage } = reply;
  const stop = { stop_reason: reply.stop.reason, stop_sequence: reply.stop.sequence };
  // A usage that does not read is shown as it was sent, with why, before the usage that did.
  const misfit = usage.refused.length === 0 ? [] : receivedParts(usage.refused.map(({ why }) => why).join("; "), { kind: "json", value: usage.refused.length === 1 ? usage.refused[0]!.sent : usage.refused.map(({ sent }) => sent) });
  const usageParts = [...misfit, ...(misfit.length > 0 && usage.shown === undefined ? [] : [valuePart(usage.shown, "usage")])];
  const fields = [...unreadParts(reply.unread, [], unreadPart), ...eventParts(reply.events)];
  const said = Object.fromEntries(reply.unread.map(({ key, value }) => [key, value]));
  return {
    reply: reply.blocks.flatMap(sides.reply),
    own: [
      // The stop reason is the line's name; the stop sequence, when one stopped it, is its preview.
      ...one("stop reason", [
        { category: "usage", name: `stop reason: ${show(reply.stop.reason)}`, parts: [{ id: "stop", ...pickedPart(stop, [["stop_reason"], ["stop_sequence"]]) }], preview: [pickedPart(stop, [["stop_sequence"]])] },
      ]),
      ...one("usage", [{ category: "usage", name: "usage", parts: usageParts, preview: [pickedPart(usage.shown, counted)] }]),
      // Of what else the API reported, the line previews the message's id, which is all of it that varies.
      ...one("fields", fields.length === 0 ? [] : [{ category: "usage", name: "message", parts: fields, preview: [pickedPart(said, [["id"]])] }]),
    ],
    message: {
      uncached: usage.counts.input_tokens ?? undefined,
      cacheRead: usage.counts.cache_read_input_tokens ?? undefined,
      cacheWritten: usage.counts.cache_creation_input_tokens ?? undefined,
      output: usage.counts.output_tokens ?? undefined,
      stopReason: reply.stop.reason ?? undefined,
    },
  };
}

// A block of the reply, as far as it has arrived, at the reply's place: an arriving block's input the JSON text that
// streamed so far; one whose input did not read, why, first. The fields of its events no declaration names follow its
// last block.
function replyBlock(block: ReplyBlock): KeyedBlock[] {
  const content = block.is === "arriving" ? contentOf(soFar(block)) : block.block;
  const misfit: Part[] = block.is === "refused" ? [{ ...doesNotFit(block.why), id: "input misfit" }] : [];
  const blocks = formatContent(content, "assistant");
  const last = blocks.length - 1;
  const shown = blocks.map((one, index) => ({ ...one, parts: [...(index === 0 ? misfit : []), ...one.parts, ...(index === last ? eventParts(block.events) : [])] }));
  return placed({ in: "reply" }, contentBlocks(`content.${block.index}`, shown));
}

// The fields of a reply's events no declaration names, each by its path from its event, its event's name first.
const eventParts = (events: readonly EventField[]): Part[] =>
  events.length === 0 ? [] : [{ id: "events", label: "event fields", kind: "rest", fields: events.map(({ at, value }): Field => [at.join("."), fieldValue(value)]) }];

// The counts a usage line previews: the tokens read, uncached, from the cache and written to it, and written out, of which
// the thinking's.
const counted = [["input_tokens"], ["cache_read_input_tokens"], ["cache_creation_input_tokens"], ["output_tokens"], ["output_tokens_details", "thinking_tokens"]];

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
