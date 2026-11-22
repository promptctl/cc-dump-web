import {
  apart,
  either,
  fieldOf,
  fields,
  kinds,
  mapped,
  object,
  optional,
  parsed,
  raw as anything,
  taken,
  unreadFields,
  value,
  when,
  whole,
  worded,
  type Fields,
  type Outcomes,
  type Path,
  type Reader,
  type Readers,
  type Taken,
  type Unread,
  type Whole,
} from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { restParts, receivedParts, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import { anyTool, toolNamed, type Tool } from "./tools.ts";
import { namedIn, type Notice } from "./wire.ts";

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
// that runs a subagent; and whether the reply that makes it `waits` for its result, which every call's does but a
// subagent's SubagentHandback, which hands its report back and ends its work.
export type Call = { id: string; launches: Launch | undefined; waits: boolean };
// What a call launches: an Agent call a subagent, of the agent `type` it names where it names one; a Skill call the
// skill it names, which runs in a subagent when the skill forks.
export type Launch = { tool: "Agent"; type: string | undefined } | { tool: "Skill"; skill: string };
// [LAW:one-source-of-truth] What a launch is called where it is shown: an Agent call's agent type, where it names one,
// and a Skill call's skill as the command that runs it, so a skill and an agent type of one name read apart.
export const launchName = (launches: Launch): string | undefined => (launches.tool === "Agent" ? launches.type : `/${launches.skill}`);
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

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
export function formatError(error: unknown, unread: readonly Unread[]): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unreadParts(unread)] };
}

// [LAW:nothing-unseen] The fields of an object no read asked for, at their paths below `from`, as the part holding a
// block's fields, when there are any.
export const unreadParts = (unread: readonly Unread[], from: Path = []) => restParts(unreadFields(unread, from), { id: "unread", label: "fields" });

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// [LAW:single-enforcer] The parts of an object read field by field: when every field read, what `show` makes of them,
// beside the fields under `holds` its readers did not read, and then the object's other fields no reader read; else, at
// any depth, every refusal, once, and the object as it was sent.
export function shownParts<T>(
  read: Taken<Outcomes<T>>,
  sent: unknown,
  show: (value: Whole<Outcomes<T>>, held: Record<string, unknown>) => Part[],
  holds?: string,
): Part[] {
  const walked = read.is === "read" ? whole(read.value) : read;
  if (walked.is === "refused") return receivedParts(worded(walked.refusals), { kind: "json", value: sent });
  const isHeld = ({ at }: Unread) => holds !== undefined && at[0] === holds;
  const held = unreadFields(walked.unread.filter(isHeld), holds === undefined ? [] : [holds]);
  return [...show(walked.value, held), ...unreadParts(walked.unread.filter((field) => !isHeld(field)))];
}

// A content block as the block the view shows, and the text it holds, where it is a text block whose text read: what a
// message's text is split into, and what a tool's result names (format/wire.ts).
export type ReadBlock = { block: Block; text: string | undefined };

// How one content block type is shown, its fields, all but its type, read once by `readers` (by the role of the
// message holding it), each to its outcome. `category`, `name` (its type, where it says none), what it `stated` and
// whether its tool `failed` are read off those outcomes, so a block one field of which does not read says them still.
// `show`: its parts, once every field read, a text block's text read in `form`: Markdown in a message, verbatim in what
// a tool or a document returned. `holds`: the field whose fields no reader read `show` shows among its own.
type Entry<T> = {
  readers: (role: Role) => Readers<T>;
  category: (fields: Fields<T>, role: Role) => Category;
  name?: (fields: Fields<T>, type: string) => string;
  stated?: (fields: Fields<T>, role: Role) => Stated;
  failed?: (fields: Fields<T>) => boolean;
  text?: (fields: Fields<T>) => string | undefined;
  show: (block: Whole<Outcomes<T>>, form: Form, held: Record<string, unknown>) => Part[];
  holds?: string;
};
// A content block of `type`, its other fields `rest`, as it was `sent`, shown.
type Format = (type: string, rest: Record<string, unknown>, sent: unknown, role: Role, form: Form) => ReadBlock;

const entry =
  <T>(shown: Entry<T>): Format =>
  (type, rest, sent, role, form) => {
    const read: Taken<Outcomes<T>> = { is: "read", ...fields(shown.readers(role))(rest, []) };
    const { fields: outcomes } = read.value;
    const name = shown.name?.(outcomes, type) ?? type;
    const parts = shownParts(read, sent, (block, held) => shown.show(block, form, held), shown.holds);
    const block: Block = { category: shown.category(outcomes, role), name, parts, ...shown.stated?.(outcomes, role) };
    // A tool's result that says its tool failed is named for it.
    return { block: shown.failed?.(outcomes) ? { ...block, name: `${name}: error`, failed: true } : block, text: shown.text?.(outcomes) };
  };

const string = value(kinds.string);
const byRole = (_: unknown, role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const fieldPart = (name: string, text: string): Part => ({ id: name, kind: "fields", fields: [[name, text]] });

// A tool use, its input read by its tool (format/tools.ts): a client tool's, by the tool its name names, a server tool's
// or an MCP server's, whose names are their own and may be any, as its JSON. Only a client tool's call states one.
// [LAW:types-are-the-program] The tool is chosen by the name as sent, so a name that is no tool's, `__proto__` or
// `constructor`, has none; the name is stated, and refused, by the block's own read of it.
type Use = { id: string; name: string };
const usedName = ({ name }: Fields<Use>, type: string) => when(name, (name) => `${type}: ${name}`, type);
const call = ({ id, name }: Fields<Use>, launches: Launch | undefined): Stated =>
  when(id, (id): Stated => ({ call: { id, launches, waits: when(name, (name) => name !== "SubagentHandback", true) } }), {});

function toolUse<T>(tool: Tool<T>, calls: boolean): Format {
  return entry<Use & { input: T }>({
    readers: () => ({ id: string, name: string, input: tool.input }),
    category: tools,
    name: usedName,
    holds: "input",
    show: ({ id, input }, _, held) => [...tool.show(input, held), fieldPart("id", id)],
    ...(calls ? { stated: (use: Fields<Use & { input: T }>) => call(use, tool.launches?.(use.input)) } : {}),
  });
}
// A tool use whose input a stream has sent so far (format/stream.ts): the JSON of its input's deltas, joined, which is
// not yet JSON, shown as the text it is, another text than the input it becomes. Its call launches what its tool does
// with no input read.
function streamingUse<T>(tool: Tool<T>, calls: boolean): Format {
  return entry<Use & { partial_json: string }>({
    readers: () => ({ id: string, name: string, partial_json: string }),
    category: tools,
    name: usedName,
    show: ({ id, partial_json }) => [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: partial_json }, fieldPart("id", id)],
    ...(calls ? { stated: (use: Fields<Use>) => call(use, tool.launches?.({ is: "missing", at: ["input"] })) } : {}),
  });
}
const used =
  (calls: boolean): Format =>
  (type, rest, ...shown) =>
    (calls ? toolNamed(fieldOf(rest, "name")) : anyTool)((tool) => (Object.hasOwn(rest, "partial_json") ? streamingUse : toolUse)(tool, calls))(type, rest, ...shown);

// [LAW:types-are-the-program] The content of a tool result, a document or a search result: a string, or content blocks,
// each read as a message's are. Its text is what the tool or the source returned, read verbatim.
type Content = string | ReadBlock[];
const content = (role: Role): Reader<Content> =>
  either({ kind: kinds.string, read: string }, { kind: kinds.list, read: parsed(kinds.list, (blocks) => blocks.map((block) => readBlock(block, role, "verbatim"))) });
const texts = (content: Content): string[] => (typeof content === "string" ? [content] : content.flatMap(({ text }) => (text === undefined ? [] : [text])));
// Its parts: a string's text, or each block's parts, named under its block's index in the list, which only grows at its end.
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
  stated: ({ tool_use_id, content }) => when(tool_use_id, (answers): Stated => ({ result: { answers, names: namedIn(when(content, (content) => (content === undefined ? [] : texts(content)), [])) } }), {}),
  failed: ({ is_error }) => when(is_error, (failed) => failed === true, false),
  show: ({ tool_use_id, content, is_error }) => [
    ...(content === undefined ? [] : contentParts(content)),
    { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", String(is_error)] satisfies [string, string]])] },
  ],
});

// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each; content that is a list holds what it found.
type ServerContent = { sent: unknown; failed: boolean };
const serverContent: Reader<ServerContent> = either(
  { kind: kinds.list, read: mapped(anything, (sent): ServerContent => ({ sent, failed: false })) },
  { kind: kinds.object, read: (json, at) => mapped(apart("type", kinds.string), ({ is }): ServerContent => ({ sent: json, failed: is.endsWith("_error") }))(json, at) },
);
const serverToolResult = entry<{ tool_use_id: string; content: ServerContent }>({
  readers: () => ({ tool_use_id: string, content: serverContent }),
  category: tools,
  failed: ({ content }) => when(content, ({ failed }) => failed, false),
  show: ({ tool_use_id, content }) => [{ id: "content", label: "content", kind: "json", value: content.sent }, fieldPart("tool_use_id", tool_use_id)],
});

// An image's or a document's source, by its type: media the view shows, the text a text document holds, or the blocks of
// a content document. A source of another type is shown by its type, its fields with the source's others.
const media = (of: Medium, source: Extract<Part, { kind: "media" }>["source"]): Part[] => [{ id: "source", kind: "media", of, source }];
const sources = new Map<string, (of: Medium, role: Role) => Reader<Part[]>>([
  ["base64", (of) => mapped(object({ media_type: string, data: string }), ({ media_type, data }) => media(of, { type: "base64", media_type, data }))],
  ["url", (of) => mapped(object({ url: string }), ({ url }) => media(of, { type: "url", url }))],
  ["file", (of) => mapped(object({ file_id: string }), ({ file_id }) => media(of, { type: "file", file_id }))],
  ["text", () => mapped(object({ data: string }), ({ data }): Part[] => [{ id: "source", kind: "text", form: "verbatim", text: data }])],
  ["content", (_, role) => mapped(object({ content: content(role) }), ({ content }) => contentParts(content))],
]);
const source =
  (of: Medium, role: Role): Reader<Part[]> =>
  (json, at) => {
    const { is, rest } = apart("type", kinds.string)(json, at).value;
    const read = sources.get(is)?.(of, role) ?? mapped(object({}), (): Part[] => [{ id: "source", label: "source", kind: "fields", fields: [["type", is]] }]);
    return read(rest, at);
  };
const ofSource = (of: Medium) =>
  entry<{ source: Part[] }>({
    readers: (role) => ({ source: source(of, role) }),
    category: byRole,
    holds: "source",
    show: ({ source }, _, held) => [...source, ...restParts(held, { id: "source/unread", label: "source fields" })],
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
  const summary = role === "assistant" ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3). One whose thinking does not read is shown
// among the thinking, why with it. A streamed thinking block has no signature until its signature delta, just before
// its stop.
const thinking = entry<{ thinking: string; signature: string | undefined }>({
  readers: () => ({ thinking: string, signature: optional(string) }),
  category: ({ thinking }) => when(thinking, (text) => (text === "" ? "usage" : "thinking"), "thinking"),
  show: ({ thinking, signature }) => [
    { id: "thinking", kind: "text", form: "markdown", text: thinking },
    fieldPart("signature", signature === undefined ? "none" : `${signature.length} characters`),
  ],
});

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const formats = new Map<string, Format>([
  [
    "text",
    entry<{ text: string }>({
      readers: () => ({ text: string }),
      category: byRole,
      show: ({ text }, form) => [textPart(text, form)],
      stated: ({ text }, role) => when(text, (text) => summarized(text, role), {}),
      text: ({ text }) => when(text, (text) => text, undefined),
    }),
  ],
  ["thinking", thinking],
  ["redacted_thinking", entry<{ data: string }>({ readers: () => ({ data: string }), category: () => "usage", show: ({ data }) => [fieldPart("data", `${data.length} characters`)] })],
  ["tool_use", used(true)],
  ["server_tool_use", used(false)],
  ["mcp_tool_use", used(false)],
  ["tool_result", toolResult],
  ["mcp_tool_result", toolResult],
  ["web_search_tool_result", serverToolResult],
  ["web_fetch_tool_result", serverToolResult],
  ["code_execution_tool_result", serverToolResult],
  ["bash_code_execution_tool_result", serverToolResult],
  ["text_editor_code_execution_tool_result", serverToolResult],
  ["tool_search_tool_result", serverToolResult],
  ["container_upload", entry<Record<never, never>>({ readers: () => ({}), category: tools, show: () => [] })],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    entry<{ source: string; title: string; content: Content }>({
      readers: (role) => ({ source: string, title: string, content: content(role) }),
      category: byRole,
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

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block with no type, and
// one its entry cannot read, is shown the same way, with why.
export function readBlock(sent: unknown, role: Role, form: Form): ReadBlock {
  const tag = taken(apart("type", kinds.string), sent, []);
  if (tag.is === "refused") return { block: raw(roleCategory[role], "content block", worded(tag.refusals), { kind: "json", value: sent }), text: undefined };
  const { is, rest } = tag.value;
  const format = formats.get(is);
  if (format === undefined) return { block: { category: roleCategory[role], name: is, parts: [{ id: "block", kind: "json", value: sent }] }, text: undefined };
  return format(is, rest, sent, role, form);
}
export const formatBlock = (sent: unknown, role: Role, form: Form): Block => readBlock(sent, role, form).block;

// A content block of a message in `role`, as the blocks the view shows: the one block `readBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(sent: unknown, role: Role): Block[] {
  const { block: formatted, text } = readBlock(sent, role, "markdown");
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
