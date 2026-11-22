import {
  asRead,
  fields,
  holding,
  kinds,
  list,
  mapped,
  object,
  optional,
  raw as anything,
  readBy,
  shaped,
  taggedFields,
  taken,
  unreadFields,
  value,
  when,
  wholeOf,
  worded,
  type Fields,
  type Holding,
  type Outcome,
  type Outcomes,
  type Path,
  type Reader,
  type Readers,
  type Taken,
  type Unread,
  type Whole,
} from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { fieldPart, restParts, receivedParts, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import { anyTool, toolNamed, type AnyTool, type Input, type Launch, type Tool } from "./tools.ts";
import { namedIn, type Notice } from "./wire.ts";

export { launchName, type Launch } from "./tools.ts";

// The blocks the view shows, and the formatter of the Messages API's content blocks into them.

// [LAW:one-source-of-truth] The kinds of content a block belongs to (docs/design/01-features.md, "Vocabulary"), in the order
// the filter bar lists them: what was said and sent, then the exchange's envelope by where it is from. `parameters`:
// what a request asks beside its prompt and its messages, its cache breakpoints and a message's other fields among
// them. `usage`: what the API reported about its reply, why it stopped and what it counted. `http`: the wire as it was
// received, each side's head, a body or an event not read, and how the connection ended.
export const categories = ["user", "assistant", "tools", "system", "thinking", "parameters", "usage", "http"] as const;
export type Category = (typeof categories)[number];

// [LAW:types-are-the-program] `injected`: the harness's own content in a message the user or the assistant sent, a system
// reminder, hook output or a CLAUDE.md, which the view never mistakes for what they said, whatever its category.
// `preview`: the parts the block's collapsed line reads in place of its own (docs/design/02-design.md, "Print what
// varies"), for a block whose first part with content is not what tells it from its kind's others (view/rows.ts).
// `failed`: a tool's result that says its tool failed (its is_error), which the minimap marks in the theme's error.
// [LAW:one-source-of-truth] What a block states that the history reads (view/history.ts), here and never back out of
// its parts: `call`, a client tool's call; `result`, a client tool's result; `notice`, the harness's notification that an
// agent stopped (format/wire.ts); `summary`, the summary an assistant's text ends with, as the reply to a compaction
// does, which the thread that carries it on begins with.
export type Block = { category: Category; name: string; parts: Part[]; injected?: true; preview?: PartBody[]; failed?: true } & Stated;
export type Stated = { call?: Call; result?: Answer; notice?: Notice; summary?: string };

// [LAW:types-are-the-program] A client tool's call: its `id`, which its result answers; what it `launches`, for a tool
// that runs a subagent; and whether the reply that makes it `waits` for its result (format/tools.ts).
export type Call = { id: string; launches: Launch | undefined; waits: boolean };
// A client tool's result: the call it `answers`, and the agent its content `names`, where it names one (format/wire.ts).
export type Answer = { answers: string; names: string | undefined };

// What a source of at most one block gives: none, or the one, ready to spread among a group's blocks.
export type BlockOrNone = [] | [Block];

// The roles a message speaks in. Claude Code sends system-role messages among the user's and the assistant's.
export const roles = ["user", "assistant", "system"] as const;
export type Role = (typeof roles)[number];
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-features.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
const pieces: Record<Role, (text: string) => Piece[]> = {
  user: (text) => split(text, "said"),
  assistant: (text) => [{ kind: "said", text, content: text }],
  system: (text) => split(text, "harness"),
};

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Received): Block {
  return { category, name, parts: receivedParts(reason, received) };
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have,
// with the fields `beside` it, which no read asked for.
export function formatError({ read, others }: Holding<{ error: unknown }>): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: read.error }, ...restParts(others, unreadPart)] };
}
// The reader of an error the API returned, as a body or an event holds it.
export const apiError = holding(object({ error: anything }));

// [LAW:nothing-unseen] The fields of an object no read asked for, at their paths below `from`, as the part holding a
// block's fields, when there are any.
const unreadPart = { id: "unread", label: "fields" };
export const unreadParts = (unread: readonly Unread[], from: Path = []) => restParts(unreadFields(unread, from), unreadPart);

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// [LAW:single-enforcer] The parts of a value read: when it read whole, what `show` makes of it, then its fields no
// reader read; else, at any depth, every refusal, once, and the value as it was sent.
export function shownParts<T>(read: Taken<T>, sent: unknown, show: (value: Whole<T>) => Part[]): Part[] {
  const walked = wholeOf(read);
  if (walked.is === "refused") return receivedParts(worded(walked.refusals), { kind: "json", value: sent });
  return [...show(walked.value), ...unreadParts(walked.unread)];
}

// [LAW:one-source-of-truth] A cache breakpoint set on a content block, `at` the path of the block it is set on among the
// blocks it holds, none for its own, and its `cache_control` as sent. A breakpoint is the request's, not its block's
// (format.ts), so every block reads its `cache_control` apart from its other fields, whether or not they read, and
// shows none of it.
export type Breakpoint = { at: Path; value: unknown };

// A content block as the block the view shows; the text it holds, where it is a text block whose text read: what a
// message's text is split into, and what a tool's result names (format/wire.ts); and the cache breakpoints set on it and
// on the blocks it holds.
export type ReadBlock = { block: Block; text: string | undefined; breakpoints: Breakpoint[] };

// What a content block says beside its parts, read off its fields' outcomes, so a block one field of which does not
// read says it still: what it states, whether it says its tool failed, the text it holds, and the breakpoints set on the
// blocks its content holds.
type Facts = { stated: Stated; failed: boolean; text: string | undefined; breakpoints: Breakpoint[] };
const noFacts = (): Facts => ({ stated: {}, failed: false, text: undefined, breakpoints: [] });

// [LAW:types-are-the-program] How one content block type is shown, its fields, all but its type, read once by
// `readers` (by the role of the message holding it), each to its outcome: its `category`, its `name` (by its type), its
// `facts`, and `show`, its parts once every field read, a text block's text read in `form`: Markdown in a message,
// verbatim in what a tool or a document returned.
type Entry<T> = {
  readers: (role: Role) => Readers<T>;
  category: (fields: Fields<T>, role: Role) => Category;
  name: (fields: Fields<T>, type: string) => string;
  facts: (fields: Fields<T>, role: Role) => Facts;
  show: (block: Whole<Outcomes<T>>, form: Form) => Part[];
};
// A content block of `type`, as it was `sent`, read from its other fields.
type Format = (type: string, sent: unknown, role: Role, form: Form) => Reader<ReadBlock>;

const string = value(kinds.string);
const byRole = (_: unknown, role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const typeName = (_: unknown, type: string) => type;
// [LAW:one-source-of-truth] A block's `cache_control`, read as sent, whatever it holds.
const breakpointOf = (cache: Outcome<unknown>): Breakpoint[] => when(cache, (value) => (value === undefined ? [] : [{ at: [], value }]), []);

type Cached = { cache_control: unknown };
const entry =
  <T>(shown: Entry<T>): Format =>
  (type, sent, role, form) =>
  (rest, at) => {
    // [LAW:types-are-the-program] exception: `readers` with one reader more is `Readers<T & Cached>`, which TypeScript
    // does not relate to a spread for a generic `T`.
    const readers = { ...shown.readers(role), cache_control: optional(anything) } as Readers<T & Cached>;
    const read = fields(readers)(rest, at);
    const own = read.value.fields;
    const { stated, failed, text, breakpoints } = shown.facts(own, role);
    const name = shown.name(own, type);
    const parts = shownParts({ is: "read", ...read }, sent, (block) => shown.show(block, form));
    // A tool's result that says its tool failed is named for it.
    const block: Block = { category: shown.category(own, role), name: failed ? `${name}: error` : name, parts, ...stated, ...(failed ? { failed: true } : {}) };
    return asRead({ block, text, breakpoints: [...breakpointOf(own.cache_control), ...breakpoints] });
  };

// A tool use, its input read by its tool (format/tools.ts): a client tool's, by the tool its name names, a server tool's
// or an MCP server's, whose names are their own and may be any, as its JSON. [LAW:types-are-the-program] The tool is
// chosen by the name's own read, so a name that is no tool's, `__proto__` or `constructor`, and one that did not
// read, has none. While a stream sends it, its input so far is the JSON of its input's deltas, joined, `partial_json`
// (format/stream.ts), which is not yet JSON, shown as the text it is, the input its start sent standing in for the input
// until its block stops; so a call holding `partial_json` is one whose input is still streaming.
type Use<T> = { id: string; name: string; input: T; partial_json: undefined };
type Streaming = { id: string; name: string; input: unknown; partial_json: string };
// What a tool use states: a client tool's its call; a server tool's none.
type Stating = <T>(tool: Tool<T>, id: Outcome<string>, input: Input<T>) => Stated;
const calls: Stating = (tool, id, input) => when(id, (id): Stated => ({ call: { id, launches: tool.launches(input), waits: tool.waits } }), {});
const statesNone: Stating = () => ({});
const usedName = ({ name }: Fields<{ name: string }>, type: string) => when(name, (name) => `${type}: ${name}`, type);

const used =
  (toolOf: (name: Outcome<string>) => AnyTool, states: Stating): Format =>
  (type, sent, role, form) =>
    readBy("name", string, (name, named) =>
      toolOf(name)(<T,>(tool: Tool<T>) =>
        readBy("partial_json", string, (partial, sofar) =>
          (partial.is === "read"
            ? entry<Streaming>({
                readers: () => ({ id: string, name: named, input: optional(anything), partial_json: sofar }),
                category: tools,
                name: usedName,
                facts: ({ id }) => ({ ...noFacts(), stated: states(tool, id, { is: "streaming" }) }),
                show: ({ id, partial_json }) => [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: partial_json }, fieldPart("id", id)],
              })
            : entry<Use<T>>({
                // [LAW:types-are-the-program] exception: here `partial_json` was not sent or did not read, so its read is
                // none or refused, never a string, which no type carries from the outcome that chose this entry.
                readers: () => ({ id: string, name: named, input: tool.input, partial_json: optional(sofar) as Reader<undefined> }),
                category: tools,
                name: usedName,
                facts: ({ id, input }) => ({ ...noFacts(), stated: states(tool, id, input) }),
                show: ({ id, input }) => [...tool.show(input), fieldPart("id", id)],
              }))(type, sent, role, form),
        ),
      ),
    );

// [LAW:types-are-the-program] The content of a tool result, a document or a search result: a string, or content blocks,
// each read as a message's are. Its text is what the tool or the source returned, read verbatim.
type Content = string | ReadBlock[];
const content = (role: Role): Reader<Content> => shaped<Content>({ string, list: list((json) => asRead(readBlock(json, role, "verbatim"))) });
const texts = (content: Content): string[] => (typeof content === "string" ? [content] : content.flatMap(({ text }) => (text === undefined ? [] : [text])));
// Its parts: a string's text, or each block's parts, named under its block's index in the list, which only grows at its end.
// The breakpoints of the blocks content holds, each below its block's index.
const contentBreakpoints = (content: Content | undefined): Breakpoint[] =>
  typeof content === "string" || content === undefined ? [] : content.flatMap(({ breakpoints }, index) => breakpoints.map(({ at, value }) => ({ at: [index, ...at], value })));
const contentParts = (content: Content): Part[] =>
  typeof content === "string"
    ? [{ id: "content", kind: "text", form: "verbatim", text: content }]
    : content.flatMap(({ block }, index) => block.parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));

// A client tool's result: its content is optional, as a result may say only that its tool failed. It states the call
// it answers and the agent its texts name; its tool failed as its is_error says. Its id follows what it holds: it is how
// a call and its result refer to each other, not what either says.
type Result = { tool_use_id: string; content: Content | undefined; is_error: boolean | undefined };
const toolResult = entry<Result>({
  readers: (role) => ({ tool_use_id: string, content: optional(content(role)), is_error: optional(value(kinds.boolean)) }),
  category: tools,
  name: typeName,
  facts: ({ tool_use_id, content, is_error }) => ({
    ...noFacts(),
    stated: when(tool_use_id, (answers): Stated => ({ result: { answers, names: namedIn(when(content, (content) => (content === undefined ? [] : texts(content)), [])) } }), {}),
    failed: when(is_error, (failed) => failed === true, false),
    breakpoints: when(content, contentBreakpoints, []),
  }),
  show: ({ tool_use_id, content, is_error }) => [
    ...(content === undefined ? [] : contentParts(content)),
    { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", String(is_error)] satisfies [string, string]])] },
  ],
});

// A server tool's result says its tool failed by its content's type, the tool's error type, which the Messages API names
// for each result type (`web_search_tool_result_error` for `web_search_tool_result`); content that is a list holds what
// it found. Shown as it was sent.
type ServerContent = { sent: unknown; failed: boolean };
const serverContent = (error: string): Reader<ServerContent> =>
  shaped({
    list: mapped(anything, (sent): ServerContent => ({ sent, failed: false })),
    object: (json, at) => taggedFields("type", (is) => mapped(anything, (): ServerContent => ({ sent: json, failed: is === error })))(json, at),
  });
const serverToolResult = (type: string) =>
  [
    type,
    entry<{ tool_use_id: string; content: ServerContent }>({
      readers: () => ({ tool_use_id: string, content: serverContent(`${type}_error`) }),
      category: tools,
      name: typeName,
      facts: ({ content }) => ({ ...noFacts(), failed: when(content, ({ failed }) => failed, false) }),
      show: ({ tool_use_id, content }) => [{ id: "content", label: "content", kind: "json", value: content.sent }, fieldPart("tool_use_id", tool_use_id)],
    }),
  ] as const;

// An image's or a document's source, by its type: media the view shows, the text a text document holds, or the blocks of
// a content document. A source of another type is shown by its type, its other fields with the block's.
const media = (of: Medium, source: Extract<Part, { kind: "media" }>["source"]): Part[] => [{ id: "source", kind: "media", of, source }];
// A source, shown: its parts, and the breakpoints of the blocks a content document holds.
type Source = { parts: Part[]; breakpoints: Breakpoint[] };
const shownSource = (parts: Part[]): Source => ({ parts, breakpoints: [] });
const sources = new Map<string, (of: Medium, role: Role) => Reader<Source>>([
  ["base64", (of) => mapped(object({ media_type: string, data: string }), ({ media_type, data }) => shownSource(media(of, { type: "base64", media_type, data })))],
  ["url", (of) => mapped(object({ url: string }), ({ url }) => shownSource(media(of, { type: "url", url })))],
  ["file", (of) => mapped(object({ file_id: string }), ({ file_id }) => shownSource(media(of, { type: "file", file_id })))],
  ["text", () => mapped(object({ data: string }), ({ data }) => shownSource([{ id: "source", kind: "text", form: "verbatim", text: data }]))],
  ["content", (_, role) => mapped(object({ content: content(role) }), ({ content }) => ({ parts: contentParts(content), breakpoints: contentBreakpoints(content) }))],
]);
const otherSource = (is: string): Reader<Source> => mapped(object({}), () => shownSource([{ id: "source", label: "source", kind: "fields", fields: [["type", is]] }]));
// A source's fields its type does not read are shown with it, as its own.
const ofSource = (of: Medium) =>
  entry<{ source: Holding<Source> }>({
    readers: (role) => ({ source: holding(taggedFields("type", (is) => sources.get(is)?.(of, role) ?? otherSource(is))) }),
    category: byRole,
    name: typeName,
    facts: ({ source }) => ({ ...noFacts(), breakpoints: when(source, ({ read }) => read.breakpoints, []) }),
    show: ({ source: { read, others } }) => [...read.parts, ...restParts(others, { id: "source/unread", label: "source fields" })],
  });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (text: string, role: Role): Stated => {
  const summary = role === "assistant" ? summaryEnding.exec(text)?.[1]?.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3). One whose thinking does not read, missing or
// refused, is shown among the thinking, why with it. A streamed thinking block has no signature until its signature
// delta, just before its stop.
const thinking = entry<{ thinking: string; signature: string | undefined }>({
  readers: () => ({ thinking: string, signature: optional(string) }),
  category: ({ thinking }) => when(thinking, (text) => (text === "" ? "usage" : "thinking"), "thinking"),
  name: typeName,
  facts: noFacts,
  show: ({ thinking, signature }) => [
    { id: "thinking", kind: "text", form: "markdown", text: thinking },
    fieldPart("signature", signature === undefined ? "none" : `${signature.length} characters`),
  ],
});

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its JSON under its type name.
const formats = new Map<string, Format>([
  [
    "text",
    entry<{ text: string }>({
      readers: () => ({ text: string }),
      category: byRole,
      name: typeName,
      facts: ({ text }, role) => ({ ...noFacts(), stated: when(text, (text) => summarized(text, role), {}), text: when(text, (text) => text, undefined) }),
      show: ({ text }, form) => [textPart(text, form)],
    }),
  ],
  ["thinking", thinking],
  ["redacted_thinking", entry<{ data: string }>({ readers: () => ({ data: string }), category: () => "usage", name: typeName, facts: noFacts, show: ({ data }) => [fieldPart("data", `${data.length} characters`)] })],
  ["tool_use", used(toolNamed, calls)],
  ["server_tool_use", used(() => anyTool, statesNone)],
  ["mcp_tool_use", used(() => anyTool, statesNone)],
  ["tool_result", toolResult],
  ["mcp_tool_result", toolResult],
  serverToolResult("web_search_tool_result"),
  serverToolResult("web_fetch_tool_result"),
  serverToolResult("code_execution_tool_result"),
  serverToolResult("bash_code_execution_tool_result"),
  serverToolResult("text_editor_code_execution_tool_result"),
  serverToolResult("tool_search_tool_result"),
  ["container_upload", entry<Record<never, never>>({ readers: () => ({}), category: tools, name: typeName, facts: noFacts, show: () => [] })],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    entry<{ source: string; title: string; content: Content }>({
      readers: (role) => ({ source: string, title: string, content: content(role) }),
      category: byRole,
      name: typeName,
      facts: ({ content }) => ({ ...noFacts(), breakpoints: when(content, contentBreakpoints, []) }),
      show: ({ source, title, content }) => [
        {
          id: "search result",
          kind: "fields",
          fields: [
            ["source", source],
            ["title", title],
          ],
        },
        ...contentParts(content),
      ],
    }),
  ],
]);

// A content block of a type with no entry: its fields as it sent them, under its type name.
const otherType: Format = (type, _, role) => (rest, at) => {
  const read = fields({ cache_control: optional(anything) })(rest, at).value;
  const block: Block = { category: roleCategory[role], name: type, parts: [{ id: "block", kind: "json", value: { type, ...unreadFields(read.unread, at) } }] };
  return asRead({ block, text: undefined, breakpoints: breakpointOf(read.fields.cache_control) });
};

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A block with no type, or whose type is not a string, is shown as its raw JSON, with why.
export function readBlock(sent: unknown, role: Role, form: Form): ReadBlock {
  const read = taken(
    taggedFields("type", (is) => (formats.get(is) ?? otherType)(is, sent, role, form)),
    sent,
    [],
  );
  return read.is === "read" ? read.value : { block: raw(roleCategory[role], "content block", worded(read.refusals), { kind: "json", value: sent }), text: undefined, breakpoints: [] };
}
export const formatBlock = (sent: unknown, role: Role, form: Form): Block => readBlock(sent, role, form).block;

// A content block of a message in `role`, as the blocks the view shows: the one block `readBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent({ block: formatted, text }: ReadBlock, role: Role): Block[] {
  if (text === undefined) return [formatted];
  const fields = formatted.parts.filter(({ id }) => id !== textId);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const last = index === textPieces.length - 1;
    const rest = last ? fields : [];
    const parts: Part[] = [textPart(piece.text, form), ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, formatted.category, formatted.name, parts), preview: [textPart(piece.content, form), ...rest], ...(last ? stated : {}) };
  });
}

// How a piece's text reads (docs/design/02-design.md, "Two voices"): a hook's output is what a program printed,
// verbatim; every other piece is prose a sender or the harness wrote, Markdown.
const pieceForm: Record<Piece["kind"], Form> = { said: "markdown", reminder: "markdown", hook: "verbatim", claude_md: "markdown", section: "markdown", notification: "markdown" };

// A piece as a block: what was said is named as its text block is, and what was injected for what it is.
function pieceBlock(piece: Piece, category: Category, said: string, parts: Part[]): Block {
  switch (piece.kind) {
    case "said":
      return { category, name: said, parts };
    case "reminder":
      return { category, name: "system reminder", parts, injected: true };
    case "hook":
      return { category, name: `${piece.name} hook`, parts, injected: true };
    case "claude_md":
      return { category, name: `CLAUDE.md ${piece.path}`, parts, injected: true };
    case "section":
      return { category, name: piece.title, parts, injected: true };
    case "notification":
      return { category, name: piece.notice.kind === "stop" ? "task notification" : `task notification not read: ${piece.notice.why}`, parts, injected: true, notice: piece.notice };
  }
}
