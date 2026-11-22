import {
  apart,
  attempt,
  either,
  fieldOf,
  fields,
  kinds,
  mapped,
  nullable,
  object,
  optional,
  parseJson,
  raw as anything,
  refusalsOf,
  taken,
  unreadFields,
  value,
  when,
  whole,
  worded,
  type Field as Outcome,
  type Fields,
  type Outcomes,
  type Refusals,
  type Taken,
} from "@cc-dump/log/json";
import { statusText } from "@cc-dump/log/status";
import type { Header } from "@cc-dump/proxy/format";
import { latest, trailersOf, type Exchange, type ExchangeShown, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { equal } from "./equal.ts";
import { formatBlock, formatContent, formatError, raw, restBlock, roles, shownParts, type Block, type BlockOrNone, type Category, type Role } from "./blocks.ts";
import { doesNotFit, fieldValue, occurrences, pickedPart, valuePart, type Field, type Part, type PartBody } from "./parts.ts";
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
// tool definitions, its system prompt and each message; and the model and the session among its parameters. Each of
// what it sends is read on its own, so one that does not read is shown as it was sent, with why, among the others.
// [LAW:one-source-of-truth] A request sends a place when it has the place's group (view/history.ts), so a whole body has
// its tools' and its system prompt's groups whether or not it sends any.
const string = value(kinds.string);
const blocksOf = either({ kind: kinds.string, read: string }, { kind: kinds.list, read: value(kinds.list) });
const sends = { tools: optional(value(kinds.list)), system: optional(blocksOf), messages: value(kinds.list) };
type Sends = { tools: unknown[] | undefined; system: string | unknown[] | undefined; messages: unknown[] };
type Sent = { body: Record<string, unknown>; read: Outcomes<Sends> };
const requestRead = mapped(value(kinds.object), (body): Sent => ({ body, read: fields(sends)(body, []).value }));

function requestBody(text: string, whole: boolean): RequestShown {
  if (!whole) return { own: one("body", leftover("request body so far", text)), sent: [], messages: 0, ...unsaid };
  const read = attempt((): Taken<Sent> => taken(requestRead, parseJson(text, "request body"), []), (refusals) => ({ is: "refused" as const, refusals }));
  if (read.is === "refused") return { own: one("body", [raw("http", "request body", worded(read.refusals), { kind: "text", form: "verbatim", text })]), sent: [], messages: 0, ...unsaid };
  const { body, read: sent } = read.value;
  const { tools, system, messages } = sent.fields;
  // [LAW:one-source-of-truth] A cache breakpoint is the request's, not the block it is set on: the cache's prefix is
  // built from the tools, then the system prompt, then the messages, and Claude Code moves the breakpoints to the
  // newest blocks on every request, so a block left holding one would differ each time it is resent. They are lifted
  // out of the blocks in that order, into one block of the request's own.
  const breakpoints: Field[] = [];
  const toolGroup = [...when(tools, (tools) => (tools === undefined ? [] : toolBlocks(tools, breakpoints)), []), ...one("tools", misread(tools, body, "tools", "tools"))];
  const systemGroup = [...when(system, (system) => (system === undefined ? [] : each("system", systemBlocks(system, breakpoints))), []), ...one("system", misread(system, body, "system", "system"))];
  const { groups, speakers } = when(messages, (messages) => messageGroups(messages, breakpoints), { groups: [], speakers: 0 });
  // Every other field is a parameter, so one the API adds is shown with the rest, in the order sent; the model and the
  // metadata stay among them. Its line previews those a client varies from one request to the next.
  const parameters = unreadFields(sent.unread);
  const { model, metadata } = fields({ model: optional(string), metadata: optional(anything) })(parameters, []).value.fields;
  const parametersBlock: Block = {
    category: "parameters",
    name: "parameters",
    parts: [...misfit(model), valuePart(parameters, "parameters")],
    preview: [pickedPart(parameters, varied)],
  };
  // Its line previews where they are.
  const places: PartBody = { kind: "text", form: "verbatim", text: breakpoints.map(([place]) => place).join("  ") };
  const cache: BlockOrNone =
    breakpoints.length === 0 ? [] : [{ category: "parameters", name: `cache breakpoints: ${breakpoints.length}`, parts: [{ id: "breakpoints", kind: "fields", fields: breakpoints }], preview: [places] }];
  return {
    own: [...placed({ in: "parameters" }, one("parameters", [parametersBlock])), ...one("cache", cache), ...one("messages", misread(messages, body, "http", "messages"))],
    sent: [{ key: "tools", title: "tools", blocks: placed({ in: "tools" }, toolGroup) }, { key: "system", title: "system", blocks: placed({ in: "system" }, systemGroup) }, ...groups],
    messages: speakers,
    model: when(model, (model) => model, undefined),
    session: when(metadata, sessionOf, undefined),
  };
}

// What a field that did not read shows: why, as the part a block shows first.
const misfit = (field: Outcome<unknown>): Part[] => (field.is === "read" ? [] : [doesNotFit(worded(refusalsOf(field)))]);
// A field of `body` that did not read, as the block showing it as it was sent, with why.
const misread = (field: Outcome<unknown>, body: Record<string, unknown>, category: Category, name: string): BlockOrNone =>
  field.is === "read" ? [] : [raw(category, name, worded(refusalsOf(field)), { kind: "json", value: fieldOf(body, name) })];

// The session a request's metadata names: Claude Code's `user_id` is the JSON text of an object holding `session_id`
// (seen on Claude Code's traffic, 2026-11-16; the format is not documented). Metadata of any other shape names none:
// the session is a fact of Claude Code's requests alone, and any other client's metadata is its own.
function sessionOf(metadata: unknown): string | undefined {
  return attempt(
    () => object({ session_id: string })(parseJson(object({ user_id: string })(metadata, []).value.user_id, "user_id"), []).value.session_id,
    () => undefined,
  );
}

// A list of blocks with each block's cache breakpoint taken out of it. A block that is not an object, or whose
// cache_control is not one, holds no breakpoint, and keeps the field, for its reader to show among its fields.
type Lifted = { block: unknown; breakpoint: Record<string, unknown> | undefined };
const lift = (blocks: unknown[]): Lifted[] =>
  blocks.map((block) =>
    attempt(
      (): Lifted => {
        const { is, rest } = apart("cache_control", kinds.object)(block, []).value;
        return { block: rest, breakpoint: is };
      },
      () => ({ block, breakpoint: undefined }),
    ),
  );
// The breakpoints of lifted blocks, each at the place `at` names for its block.
const marked = (lifted: Lifted[], at: (index: number) => string): Field[] =>
  lifted.flatMap(({ breakpoint }, index): Field[] => (breakpoint === undefined ? [] : [[at(index), fieldValue(breakpoint)]]));
// The blocks a message's content or a system prompt sends: a string is the text of one text block.
const sentBlocks = (blocks: string | unknown[]): Lifted[] => (typeof blocks === "string" ? [{ block: { type: "text", text: blocks }, breakpoint: undefined }] : lift(blocks));

// The parameters a client varies from one request to the next, which a request's parameters line previews: the model,
// how many tokens it may write, how it thinks and with what effort, and how it samples.
const varied = ["model", "max_tokens", "thinking", "output_config.effort", "temperature"];

// Each message at its place: a speaker's numbered among the speakers', a system-role one among those standing before
// the same speaker's message; and how many speakers' messages there are.
const messageFields = { role: value(kinds.among(roles)), content: blocksOf };
type Message = { role: Role; content: string | unknown[] };
function messageGroups(messages: unknown[], breakpoints: Field[]): { groups: Group[]; speakers: number } {
  let speakers = 0;
  let standing = 0;
  const groups = messages.map((sent) => {
    const read = taken(fields(messageFields), sent, []);
    const system = when(read, ({ fields }) => when(fields.role, (role) => role === "system", false), false);
    const key = system ? `message.${speakers}.system.${standing}` : `message.${speakers}`;
    const place: Place = system ? { in: "system message", before: speakers, index: standing } : { in: "message", index: speakers };
    standing = system ? standing + 1 : 0;
    speakers += system ? 0 : 1;
    return messageGroup(read, sent, key, place, breakpoints);
  });
  return { groups, speakers };
}

function messageGroup(read: Taken<Outcomes<Message>>, sent: unknown, key: string, place: Place, breakpoints: Field[]): Group {
  const walked = read.is === "read" ? whole(read.value) : read;
  if (walked.is === "refused") return { key, title: "message", blocks: placed(place, one("message", [raw("http", "message", worded(walked.refusals), { kind: "json", value: sent })])) };
  const { role, content } = walked.value;
  const lifted = sentBlocks(content);
  breakpoints.push(...marked(lifted, (index) => `${key}/content.${index}`));
  return { key, title: role, blocks: [...messageContent(lifted.map(({ block }) => block), role, place), ...placed(place, one("fields", restBlock(walked.unread, "parameters", "message")))] };
}

function systemBlocks(system: string | unknown[], breakpoints: Field[]): Block[] {
  const lifted = sentBlocks(system);
  breakpoints.push(...marked(lifted, (index) => `system.${index}`));
  return lifted.map(({ block }) => formatBlock(block, "system", "markdown"));
}

// Each tool definition as a block of its own, named for its tool, its description read first and its schema after.
// [LAW:types-are-the-program] Keyed by its name, `tools.<name>.<n>`, `n` its occurrence among tools of that name, so a
// tool is the same item in every request that offers it wherever it stands in the list (view/history.ts), and the key
// is unique and has no `/` (view/position.ts) whatever a recorded request holds. A client tool is named by its name; a
// server tool by its name, its type shown beside it, or by its type where it has none. A tool that does not read is
// shown as it was sent, with why, named `tool` where neither reads.
const toolFields = { name: optional(string), type: optional(string), description: optional(string) };
type ToolDefinition = { name: string | undefined; type: string | undefined; description: string | undefined };
const toolName = ({ name, type }: Fields<ToolDefinition>): string => when(name, (name) => name, undefined) ?? when(type, (type) => type, undefined) ?? "tool";
function toolBlocks(tools: unknown[], breakpoints: Field[]): KeyedBlock[] {
  const lifted = lift(tools);
  const read = lifted.map(({ block }) => taken(fields(toolFields), block, []));
  const names = read.map((tool) => when(tool, ({ fields }) => toolName(fields), "tool"));
  const keys = toolKeys(names);
  breakpoints.push(...marked(lifted, (index) => keys[index]!));
  return read.map((tool, index) =>
    keyed(
      {
        category: "tools",
        name: names[index]!,
        parts: shownParts(tool, lifted[index]!.block, ({ name, type, description }): Part[] => [
          ...(description === undefined ? [] : [{ id: "description", kind: "text", form: "markdown", text: description } satisfies Part]),
          ...(name === undefined || type === undefined ? [] : [{ id: "type", kind: "fields", fields: [["type", type]] } satisfies Part]),
        ]),
      },
      keys[index]!,
    ),
  );
}

// Each tool's key, its name's `%` and `/` escaped as a URI's are.
function toolKeys(names: string[]): string[] {
  const counted = occurrences(names, (name) => name);
  return names.map((name, index) => `tools.${name.replaceAll("%", "%25").replaceAll("/", "%2F")}.${counted[index]}`);
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
    return {
      own: [...own, ...one("event fields", restBlock(stream.unread, "http", "event fields")), ...each("event", stream.blocks), ...one("tail", leftover("stream tail", tail))],
      reply: [...reply, ...each("error", stream.errors)],
      message,
    };
  }
  if (!whole) return none(one("body", leftover("response body so far", text)));
  const unreadable = (refusals: Refusals) => none(one("body", [raw("http", "response body", worded(refusals), { kind: "text", form: "verbatim", text })]));
  const read = attempt((): Taken<{ is: "message" | "error"; rest: Record<string, unknown> }> => taken(apart("type", kinds.among(["message", "error"])), parseJson(text, "response body"), []), (refusals) => ({ is: "refused" as const, refusals }));
  if (read.is === "refused") return unreadable(read.refusals);
  const { is, rest } = read.value;
  if (is === "message") return messageBlocks(rest);
  const error = taken(object({ error: anything }), rest, []);
  return error.is === "read" ? { ...none([]), reply: one("error", [formatError(error.value.error, error.unread)]) } : unreadable(error.refusals);
}

// A response no message was read from: the blocks that are its exchange's own, and no reply.
const none = (own: KeyedBlock[]): ResponseShown => ({ own, reply: [], message: noMessage });

// A count in a message's usage: one the API gave as null is not given.
const count = optional(nullable(value(kinds.integer)));
const usageFields = { input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count };
type Usage = { [K in keyof typeof usageFields]: number | null | undefined };
const replyFields = { content: value(kinds.list), stop_reason: nullable(string), stop_sequence: optional(nullable(string)), usage: optional(fields(usageFields)) };

// A response message: its content, which is the reply; what the API reported about it, which is the exchange's own;
// and, of what it reported, the facts. Each is read on its own, so a stop reason or a count that does not read is shown
// with why, beside what did.
function messageBlocks(message: Record<string, unknown>): ResponseShown {
  const read = fields(replyFields)(message, []).value;
  const { content, stop_reason, stop_sequence, usage: counts } = read.fields;
  const stop = { stop_reason: fieldOf(message, "stop_reason"), stop_sequence: fieldOf(message, "stop_sequence") };
  const unstopped = [stop_reason, stop_sequence].flatMap((field) => (field.is === "read" ? [] : refusalsOf(field)));
  // The usage a message sent, when it sent one, and whether every count in it read.
  const sentUsage = counts.is === "read" ? counts.value : undefined;
  const usageRead = counts.is === "read" ? (sentUsage === undefined ? undefined : whole(sentUsage)) : ({ is: "refused", refusals: refusalsOf(counts) } as const);
  const tokens = (name: keyof Usage): number | undefined => (sentUsage === undefined ? undefined : when(sentUsage.fields[name], (count) => count ?? undefined, undefined));
  const sentCounts = fieldOf(message, "usage");
  const rest = unreadFields(read.unread);
  return {
    reply: content.is === "read" ? messageContent(content.value, "assistant", { in: "reply" }) : one("content", misread(content, message, "http", "content")),
    own: [
      // The stop reason is the line's name; the stop sequence, when one stopped it, is its preview.
      ...one("stop reason", [
        {
          category: "usage",
          name: when(stop_reason, (reason) => `stop reason: ${reason ?? "null"}`, "stop reason"),
          parts: [...(unstopped.length === 0 ? [] : [doesNotFit(worded(unstopped))]), { id: "stop", ...pickedPart(stop, ["stop_reason", "stop_sequence"]) }],
          preview: [pickedPart(stop, ["stop_sequence"])],
        },
      ]),
      ...one(
        "usage",
        usageRead === undefined
          ? []
          : [{ category: "usage", name: "usage", parts: [...(usageRead.is === "refused" ? [doesNotFit(worded(usageRead.refusals))] : []), valuePart(sentCounts, "usage")], preview: [pickedPart(sentCounts, counted)] }],
      ),
      // Of what else the API reported, the line previews the message's id, which is all of it that varies.
      ...one("fields", restBlock(read.unread, "usage", "message")).map((block) => ({ ...block, preview: [pickedPart(rest, ["id"])] })),
    ],
    message: {
      uncached: tokens("input_tokens"),
      cacheRead: tokens("cache_read_input_tokens"),
      cacheWritten: tokens("cache_creation_input_tokens"),
      output: tokens("output_tokens"),
      stopReason: when(stop_reason, (reason) => reason ?? undefined, undefined),
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
