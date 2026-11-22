import { Malformed } from "@cc-dump/log/failure";
import {
  asRead,
  asSent,
  attempt,
  fields,
  kinds,
  list,
  mapped,
  nullable,
  object,
  optional,
  parsed,
  parseJson,
  raw as anything,
  readBy,
  readText,
  refusalsOf,
  rooted,
  shaped,
  taggedFields,
  unreadFields,
  value,
  when,
  whole,
  wholeOf,
  worded,
  type AsSent,
  type Fields,
  type Holding,
  type Outcome,
  type Outcomes,
  type Reader,
  type Refusal,
} from "@cc-dump/log/json";
import { statusText } from "@cc-dump/log/status";
import type { Header } from "@cc-dump/proxy/format";
import { latest, trailersOf, type Exchange, type ExchangeShown, type Of, type RequestSide, type ResponseSide } from "../exchanges.ts";
import { createDecoding, headerValues, type Body, type Decoding } from "./body.ts";
import { equal } from "./equal.ts";
import { apiError, formatContent, formatError, raw, readBlock, restBlock, roles, shownParts, type Block, type BlockOrNone, type Category, type ReadBlock, type Role } from "./blocks.ts";
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
// The blocks a message's content or a system prompt sends, each read in `role`: a string is the text of one text block.
const sentBlocks = (role: Role): Reader<ReadBlock[]> =>
  shaped<ReadBlock[]>({
    string: mapped(string, (text) => [readBlock({ type: "text", text }, role, "markdown")]),
    list: list((json) => asRead(readBlock(json, role, "markdown"))),
  });

// A message: its role, and its content read in that role. A message whose role did not read is shown as it was sent;
// its blocks are read still, for the cache breakpoints they hold, which no role changes.
type Message = { role: Role; content: ReadBlock[] };
const message: Reader<Outcomes<Message>> = readBy("role", value(kinds.among(roles)), (role, again) => fields({ role: again, content: sentBlocks(when(role, (role) => role, "user")) }));

// Each tool definition: its name, its type and its description, the others its schema and its options, shown after.
// [LAW:types-are-the-program] Keyed by its name, `tools.<name>.<n>`, `n` its occurrence among tools of that name, so a
// tool is the same item in every request that offers it wherever it stands in the list (view/history.ts), and the key
// is unique and has no `/` (view/position.ts) whatever a recorded request holds. A client tool is named by its name; a
// server tool by its name, its type shown beside it, or by its type where it has none. A tool that does not read is
// shown as it was sent, with why, named `tool` where neither reads.
type ToolDefinition = { name: string | undefined; type: string | undefined; description: string | undefined; cache_control: unknown };
const toolDefinition = fields<ToolDefinition>({ name: optional(string), type: optional(string), description: optional(string), cache_control: optional(anything) });

const sends = {
  tools: optional(asSent(list(rooted(asSent(toolDefinition))))),
  system: optional(asSent(sentBlocks("system"))),
  messages: asSent(list(rooted(asSent(message)))),
};
type Sends = { tools: AsSent<AsSent<Outcomes<ToolDefinition>>[]> | undefined; system: AsSent<ReadBlock[]> | undefined; messages: AsSent<AsSent<Outcomes<Message>>[]> };
// Every other field is a parameter, the model and the metadata among them.
const requestRead = fields<Sends>(sends);
const parameterFields = fields({ model: optional(string), metadata: optional(anything) });

function requestBody(text: string, whole: boolean): RequestShown {
  if (!whole) return { own: one("body", leftover("request body so far", text)), sent: [], messages: 0, ...unsaid };
  const read = readText(requestRead, text, "request body");
  if (read.is === "refused") return { own: one("body", [raw("http", "request body", worded(read.refusals), { kind: "text", form: "verbatim", text })]), sent: [], messages: 0, ...unsaid };
  const { tools, system, messages } = read.value.fields;
  const parameters = unreadFields(read.value.unread);
  // [LAW:one-source-of-truth] A cache breakpoint is the request's, not the block it is set on: the cache's prefix is
  // built from the tools, then the system prompt, then the messages, and Claude Code moves the breakpoints to the
  // newest blocks on every request, so a block left holding one would differ each time it is resent. Each block reads
  // its own, and they are gathered in that order, into one block of the request's own.
  const toolGroup = when(tools, (tools) => (tools === undefined ? none : toolBlocks(tools)), none);
  const systemGroup = when(system, (system) => (system === undefined ? none : systemBlocks(system)), none);
  const messageGroup = when(messages, messageGroups, { groups: [], breakpoints: [], speakers: 0 });
  const breakpoints = [...toolGroup.breakpoints, ...systemGroup.breakpoints, ...messageGroup.breakpoints];
  // Its line previews the parameters a client varies from one request to the next, in the order sent.
  const { model, metadata } = parameterFields(parameters, []).value.fields;
  const parametersBlock: Block = { category: "parameters", name: "parameters", parts: [...misfit(model), valuePart(parameters, "parameters")], preview: [pickedPart(parameters, varied)] };
  // Its line previews where they are.
  const places: PartBody = { kind: "text", form: "verbatim", text: breakpoints.map(([place]) => place).join("  ") };
  const cache: BlockOrNone =
    breakpoints.length === 0 ? [] : [{ category: "parameters", name: `cache breakpoints: ${breakpoints.length}`, parts: [{ id: "breakpoints", kind: "fields", fields: breakpoints }], preview: [places] }];
  return {
    own: [...placed({ in: "parameters" }, one("parameters", [parametersBlock])), ...one("cache", cache), ...one("messages", misread(messages, "http", "messages"))],
    sent: [
      { key: "tools", title: "tools", blocks: placed({ in: "tools" }, [...toolGroup.blocks, ...one("tools", misread(tools, "tools", "tools"))]) },
      { key: "system", title: "system", blocks: placed({ in: "system" }, [...systemGroup.blocks, ...one("system", misread(system, "system", "system"))]) },
      ...messageGroup.groups,
    ],
    messages: messageGroup.speakers,
    model: when(model, (model) => model, undefined),
    session: when(metadata, sessionOf, undefined),
  };
}

// What a group of what a request sends gives: its blocks, and the cache breakpoints set on them, each at its place.
type Sent = { blocks: KeyedBlock[]; breakpoints: Field[] };
const none: Sent = { blocks: [], breakpoints: [] };

// What a field that did not read shows: why, as the part a block shows first.
const misfit = (field: Outcome<unknown>): Part[] => (field.is === "read" ? [] : [doesNotFit(worded(refusalsOf(field)))]);
// A field that was sent but did not read, or did not come, as the block showing it as it was sent, with why.
const misread = (field: Outcome<AsSent<unknown> | undefined>, category: Category, name: string): BlockOrNone => {
  if (field.is === "missing") return [raw(category, name, worded(refusalsOf(field)), { kind: "json", value: undefined })];
  if (field.is === "refused" || field.value === undefined || field.value.read.is === "read") return [];
  return [raw(category, name, worded(field.value.read.refusals), { kind: "json", value: field.value.sent })];
};

// The session a request's metadata names: Claude Code's `user_id` is the JSON text of an object holding `session_id`
// (seen on Claude Code's traffic, 2026-11-16; the format is not documented). Metadata of any other shape names none:
// the Messages API documents `user_id` as an opaque string, so the session is a fact of Claude Code's requests alone,
// and any other client's metadata is its own.
const claudeCodeUser = object({ user_id: parsed(kinds.string, (text) => parseJson(text, "user_id")) });
const claudeCodeSession = object({ session_id: string });
function sessionOf(metadata: unknown): string | undefined {
  return attempt(
    () => claudeCodeSession(claudeCodeUser(metadata, []).value.user_id, []).value.session_id,
    () => undefined,
  );
}

// The breakpoints of read blocks, each at the place `at` names for its block, a block it holds below it by its index.
const marked = (blocks: readonly ReadBlock[], at: (index: number) => string): Field[] =>
  blocks.flatMap(({ breakpoints }, index) => breakpoints.map(({ at: path, value }): Field => [[at(index), ...path].join("/"), fieldValue(value)]));

// The parameters a client varies from one request to the next, which a request's parameters line previews: the model,
// how many tokens it may write, how it thinks and with what effort, and how it samples.
const varied = ["model", "max_tokens", "thinking", "output_config.effort", "temperature"];

// Each message at its place: a speaker's numbered among the speakers', a system-role one among those standing before
// the same speaker's message; and how many speakers' messages there are.
function messageGroups({ read }: AsSent<AsSent<Outcomes<Message>>[]>): { groups: Group[]; breakpoints: Field[]; speakers: number } {
  if (read.is === "refused") return { groups: [], breakpoints: [], speakers: 0 };
  let speakers = 0;
  let standing = 0;
  const groups = read.value.map((sent) => {
    const system = when(sent.read, ({ fields }) => when(fields.role, (role) => role === "system", false), false);
    const key = system ? `message.${speakers}.system.${standing}` : `message.${speakers}`;
    const place: Place = system ? { in: "system message", before: speakers, index: standing } : { in: "message", index: speakers };
    standing = system ? standing + 1 : 0;
    speakers += system ? 0 : 1;
    return messageGroup(sent, key, place);
  });
  return { groups: groups.map(({ group }) => group), breakpoints: groups.flatMap(({ breakpoints }) => breakpoints), speakers };
}

function messageGroup({ sent, read }: AsSent<Outcomes<Message>>, key: string, place: Place): { group: Group; breakpoints: Field[] } {
  const content = when(read, ({ fields }) => when(fields.content, (content) => content, []), []);
  const breakpoints = marked(content, (index) => `${key}/content.${index}`);
  const walked = wholeOf(read);
  if (walked.is === "refused") return { group: { key, title: "message", blocks: placed(place, one("message", [raw("http", "message", worded(walked.refusals), { kind: "json", value: sent })])) }, breakpoints };
  const { role } = walked.value;
  const blocks = content.flatMap((block, index) => contentBlocks(`content.${index}`, formatContent(block, role)));
  return { group: { key, title: role, blocks: placed(place, [...blocks, ...one("fields", restBlock(walked.unread, "parameters", "message"))]) }, breakpoints };
}

function systemBlocks({ read }: AsSent<ReadBlock[]>): Sent {
  if (read.is === "refused") return none;
  return { blocks: each("system", read.value.map(({ block }) => block)), breakpoints: marked(read.value, (index) => `system.${index}`) };
}

const toolName = ({ name, type }: Fields<ToolDefinition>): string => when(name, (name) => name, undefined) ?? when(type, (type) => type, undefined) ?? "tool";
function toolBlocks({ read }: AsSent<AsSent<Outcomes<ToolDefinition>>[]>): Sent {
  if (read.is === "refused") return none;
  const named = read.value.map((tool) => ({ tool, name: when(tool.read, ({ fields }) => toolName(fields), "tool") }));
  const tools = occurrences(named, ({ name }) => name).map(([{ tool, name }, occurrence]) => ({ tool, name, key: toolKey(name, occurrence) }));
  return {
    blocks: tools.map(({ tool, name, key }) =>
      keyed(
        {
          category: "tools",
          name,
          parts: shownParts(tool.read, tool.sent, ({ name, type, description }): Part[] => [
            ...(description === undefined ? [] : [{ id: "description", kind: "text", form: "markdown", text: description } satisfies Part]),
            ...(name === undefined || type === undefined ? [] : [{ id: "type", kind: "fields", fields: [["type", type]] } satisfies Part]),
          ]),
        },
        key,
      ),
    ),
    breakpoints: tools.flatMap(({ tool, key }) => when(tool.read, ({ fields }) => when(fields.cache_control, (cache): Field[] => (cache === undefined ? [] : [[key, fieldValue(cache)]]), []), [])),
  };
}

// A tool's key, its name's `%` and `/` escaped as a URI's are.
const toolKey = (name: string, occurrence: number): string => `tools.${name.replaceAll("%", "%25").replaceAll("/", "%2F")}.${occurrence}`;

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
    const { own, reply, message } = stream.message === undefined ? noReply([]) : messageBlocks(stream.message);
    return {
      own: [...own, ...each("event", stream.blocks), ...one("tail", leftover("stream tail", tail))],
      reply: [...reply, ...each("error", stream.errors)],
      message,
    };
  }
  if (!whole) return noReply(one("body", leftover("response body so far", text)));
  const read = readText(responseRead, text, "response body");
  if (read.is === "refused") return noReply(one("body", [raw("http", "response body", worded(read.refusals), { kind: "text", form: "verbatim", text })]));
  return read.value.is === "message" ? messageBlocks(read.value.message) : { ...noReply([]), reply: one("error", [formatError(read.value.error)]) };
}

// [LAW:types-are-the-program] A whole response body: a message, its fields but its type, or an error the API returned.
type Reply = { is: "message"; message: Record<string, unknown> } | { is: "error"; error: Holding<{ error: unknown }> };
const replies = new Map<string, Reader<Reply>>([
  ["message", mapped(anything, (message): Reply => ({ is: "message", message: message as Record<string, unknown> }))],
  ["error", mapped(apiError, (error): Reply => ({ is: "error", error }))],
]);
const responseRead = taggedFields("type", (is) => {
  const reply = replies.get(is);
  if (reply === undefined) throw new Malformed(`type: is not one of ${[...replies.keys()].join(", ")}`);
  return reply;
});

// A response no message was read from: the blocks that are its exchange's own, and no reply.
const noReply = (own: KeyedBlock[]): ResponseShown => ({ own, reply: [], message: noMessage });

// [LAW:one-source-of-truth] A message's usage: each count its own outcome, one the API gave as null not given, and its
// other fields shown with them.
const count = optional(nullable(value(kinds.integer)));
const usageFields = { input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count };
type Usage = { [K in keyof typeof usageFields]: number | null | undefined };
type ReplyFields = {
  content: AsSent<ReadBlock[]>;
  stop_reason: AsSent<string | null>;
  stop_sequence: AsSent<string | null> | undefined;
  usage: AsSent<Outcomes<Usage>> | undefined;
};
const replyFields = fields<ReplyFields>({
  content: asSent(list((json) => asRead(readBlock(json, "assistant", "markdown")))),
  stop_reason: asSent(nullable(string)),
  stop_sequence: optional(asSent(nullable(string))),
  usage: optional(asSent(fields(usageFields))),
});

// The value a field was sent with, where it was sent: what a line shows of a field whether or not it read.
const sentOf = (field: Outcome<AsSent<unknown> | undefined>): { sent: unknown } | undefined => (field.is === "read" ? field.value : undefined);
// Why a field did not read, where it did not: missing, or its value refused.
const whyNot = (field: Outcome<AsSent<unknown> | undefined>): readonly Refusal[] =>
  field.is === "read" ? (field.value === undefined || field.value.read.is === "read" ? [] : field.value.read.refusals) : refusalsOf(field);
// What a field read, where it read.
const readOf = <T>(field: Outcome<AsSent<T> | undefined>): T | undefined => (field.is === "read" && field.value !== undefined && field.value.read.is === "read" ? field.value.read.value : undefined);

// A response message: its content, which is the reply; what the API reported about it, which is the exchange's own;
// and, of what it reported, the facts. Each is read on its own, so a stop reason or a count that does not read is shown
// with why, beside what did.
function messageBlocks(message: Record<string, unknown>): ResponseShown {
  const read = replyFields(message, []).value;
  const { content, stop_reason, stop_sequence, usage } = read.fields;
  const stopped = { stop_reason: sentOf(stop_reason), stop_sequence: sentOf(stop_sequence) };
  const stop = Object.fromEntries(Object.entries(stopped).flatMap(([name, field]) => (field === undefined ? [] : [[name, field.sent]])));
  const unstopped = [...whyNot(stop_reason), ...whyNot(stop_sequence)];
  const reason = readOf(stop_reason);
  // A usage not sent shows none, and every count that did not read is named, the others kept.
  const counts = readOf(usage);
  const tokens = (name: keyof Usage): number | undefined => (counts === undefined ? undefined : when(counts.fields[name], (count) => count ?? undefined, undefined));
  const walkedCounts = counts === undefined ? undefined : whole(counts);
  const uncounted = [...whyNot(usage), ...(walkedCounts?.is === "refused" ? walkedCounts.refusals : [])];
  const sentUsage = sentOf(usage);
  const usageBlocks: BlockOrNone =
    sentUsage === undefined
      ? []
      : [{ category: "usage", name: "usage", parts: [...(uncounted.length === 0 ? [] : [doesNotFit(worded(uncounted))]), valuePart(sentUsage.sent, "usage")], preview: [pickedPart(sentUsage.sent, counted)] }];
  const rest = unreadFields(read.unread);
  return {
    reply: content.is === "read" && content.value.read.is === "read" ? placed({ in: "reply" }, content.value.read.value.flatMap((block, index) => contentBlocks(`content.${index}`, formatContent(block, "assistant")))) : one("content", misread(content, "http", "content")),
    own: [
      // The stop reason is the line's name; the stop sequence, when one stopped it, is its preview.
      ...one("stop reason", [
        {
          category: "usage",
          name: reason === undefined ? "stop reason" : `stop reason: ${reason ?? "null"}`,
          parts: [...(unstopped.length === 0 ? [] : [doesNotFit(worded(unstopped))]), { id: "stop", ...pickedPart(stop, ["stop_reason", "stop_sequence"]) }],
          preview: [pickedPart(stop, ["stop_sequence"])],
        },
      ]),
      ...one("usage", usageBlocks),
      // Of what else the API reported, the line previews the message's id, which is all of it that varies.
      ...one("fields", restBlock(read.unread, "usage", "message")).map((block) => ({ ...block, preview: [pickedPart(rest, ["id"])] })),
    ],
    message: {
      uncached: tokens("input_tokens"),
      cacheRead: tokens("cache_read_input_tokens"),
      cacheWritten: tokens("cache_creation_input_tokens"),
      output: tokens("output_tokens"),
      stopReason: reason ?? undefined,
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
