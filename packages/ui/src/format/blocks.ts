import { fieldOf, kinds, mapped, object, optional, raw as asSent, readShown, tagged, value, type Kind, type Reader, type Readers, type Unread, type Variants } from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { restParts, fieldValue, receivedParts, type Field, type Form, type Medium, type Part, type PartBody, type Received, type Source } from "./parts.ts";
import { inputParts, jsonInput } from "./tools.ts";
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
export type Role = "user" | "assistant" | "system";
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };
export const role = kinds.among<Role>(["user", "assistant", "system"]);
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-features.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
const pieces: Record<Role, (text: string) => Piece[]> = {
  user: (text) => split(text, "said"),
  assistant: (text) => [{ kind: "said", text, content: text }],
  system: (text) => split(text, "harness"),
};

// The part holding a block's fields no read asked for.
const unreadPart = { id: "unread", label: "fields" };

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Received): Block {
  return { category, name, parts: receivedParts(reason, received) };
}

// An error the API returned, as the body of an HTTP error or an event of a stream, and the fields beside it no
// declaration read: it stands where the reply would have.
export function formatError(error: unknown, unread: readonly Pick<Unread, "at" | "value">[]): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unreadParts(unread)] };
}

// The fields of a value no declaration read, as a part, when there are any.
export const unreadParts = (unread: readonly Pick<Unread, "at" | "value">[]) => restParts(unread, unreadPart);

// The fields of a value no declaration read, as a block of their own in `category`, when there are any.
export function restBlock(unread: readonly Pick<Unread, "at" | "value">[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// What a message's content is, and a tool result's, a document's or a search result's: a text, or content blocks, each
// read on its own (`formatBlock`), so one that does not read is shown raw among the others.
export type Content = string | unknown[];
const contentKind: Kind<Content> = { fits: (json): json is Content => typeof json === "string" || Array.isArray(json), expected: "a string or a list of blocks" };
export const content: Reader<Content> = value(contentKind);

const string = value(kinds.string);

// An image's or a document's source, by its type: media the view shows, the text a text document holds, the blocks of
// a content document, or, `other`, a source of a type not here, shown by its type.
type SourceRead = Source | { type: "text"; data: string } | { type: "content"; content: Content };
const source = tagged<"type", SourceRead, { other: string }>(
  "type",
  { base64: { media_type: string, data: string }, url: { url: string }, file: { file_id: string }, text: { data: string }, content: { content } },
  mapped(object<{ type: string }>({ type: string }), ({ type }) => ({ other: type })),
);

// [LAW:types-are-the-program] Every content block type the Messages API documents, each the fields it shows: a field
// not declared here is shown after its block's parts, as it was sent.
type ToolUse<T extends string> = { type: T; id: string; name: string; input: unknown };
type ToolResult<T extends string> = { type: T; tool_use_id: string; content?: Content; is_error?: boolean };
type ServerToolResult<T extends string> = { type: T; tool_use_id: string; content: unknown };
type Sourced<T extends string> = { type: T; source: SourceRead | { other: string } };
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | ToolUse<"tool_use">
  | ToolUse<"server_tool_use">
  | ToolUse<"mcp_tool_use">
  | ToolResult<"tool_result">
  | ToolResult<"mcp_tool_result">
  | ServerToolResult<"web_search_tool_result">
  | ServerToolResult<"web_fetch_tool_result">
  | ServerToolResult<"code_execution_tool_result">
  | ServerToolResult<"bash_code_execution_tool_result">
  | ServerToolResult<"text_editor_code_execution_tool_result">
  | ServerToolResult<"tool_search_tool_result">
  | { type: "container_upload" }
  | Sourced<"image">
  | Sourced<"document">
  | { type: "search_result"; source: string; title: string; content: Content };
type Type = ContentBlock["type"];

// What a block states, read off it as sent, each fact by its own field and never by its type's declaration, so a block
// its declaration refuses states them too. `category` from the role of the message holding it; `failed`, whether a
// tool's result says its tool failed; `stated`, what a thread stands after (Stated).
type Facts = {
  category: (role: Role, block: unknown) => Category;
  failed?: (block: unknown) => boolean;
  stated?: (block: unknown, role: Role) => Stated;
};
// How one content block type is shown: its declaration, `fields`; its `name`, where it is not its type; and its `parts`.
// `form`: how a text block's text reads where the block is: Markdown in a message, verbatim in what a tool or a
// document returned. `soFar`: for a block of a reply still arriving, its tool input as the JSON text sent so far.
type Entry<B extends { type: string }> = Facts & {
  fields: Readers<Omit<B, "type">>;
  name?: (block: B) => string;
  parts: (block: B, role: Role, form: Form, soFar: SoFar) => Part[];
};
// [LAW:types-are-the-program] A block's tool input as sent, `whole`, or, for a block still arriving, the JSON text sent
// so far, which is not yet JSON.
type SoFar = { is: "whole" } | { is: "arriving"; input: string };
const whole: SoFar = { is: "whole" };

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thought = (_: Role, block: unknown): Category => {
  const text = fieldOf(block, "thinking");
  return typeof text === "string" && text !== "" ? "thinking" : "usage";
};

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON.
const toolUse = (read: (name: string, input: unknown) => Part[]): Entry<ToolUse<string>> => ({
  fields: { id: string, name: string, input: asSent },
  category: tools,
  name: (block) => `${block.type}: ${block.name}`,
  parts: ({ id, name, input }, _role, _form, soFar) => {
    // An input still arriving is shown as the text it is: its deltas' `partial_json`, joined, another text than the
    // input it becomes.
    const parts: Part[] = soFar.is === "arriving" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: soFar.input }] : read(name, input);
    return [...parts, { id: "id", kind: "fields", fields: [["id", id]] }];
  },
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call with no id states none.
const launchOf = (name: unknown, input: unknown): Launch | undefined => {
  const type = fieldOf(input, "subagent_type");
  const skill = fieldOf(input, "skill");
  if (name === "Agent") return { tool: "Agent", type: typeof type === "string" ? type : undefined };
  return name === "Skill" && typeof skill === "string" ? { tool: "Skill", skill } : undefined;
};
const called = (block: unknown): Stated => {
  const id = fieldOf(block, "id");
  const name = fieldOf(block, "name");
  return typeof id === "string" ? { call: { id, launches: launchOf(name, fieldOf(block, "input")), waits: name !== "SubagentHandback" } } : {};
};

// What a client tool's result states: the call it answers, and the agent its texts name. One with no id states none.
const answered = (block: unknown): Stated => {
  const id = fieldOf(block, "tool_use_id");
  const sent = fieldOf(block, "content");
  const texts = typeof sent === "string" ? [sent] : Array.isArray(sent) ? sent.flatMap((one) => (typeof fieldOf(one, "text") === "string" ? [fieldOf(one, "text") as string] : [])) : [];
  return typeof id === "string" ? { result: { answers: id, names: namedIn(texts) } } : {};
};

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (block: unknown, role: Role): Stated => {
  const text = fieldOf(block, "text");
  const summary = role === "assistant" && typeof text === "string" ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent.
const toolResult: Entry<ToolResult<string>> = {
  fields: { tool_use_id: string, content: optional(content), is_error: optional(value(kinds.boolean)) },
  category: tools,
  stated: answered,
  failed: (block) => fieldOf(block, "is_error") === true,
  parts: ({ tool_use_id, content, is_error }, role) => {
    const id: Field[] = [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])];
    return [...(content === undefined ? [] : contentParts(content, role)), { id: "tool_use_id", kind: "fields", fields: id }];
  },
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry<ServerToolResult<string>> = {
  fields: { tool_use_id: string, content: asSent },
  category: tools,
  failed: (block) => String(fieldOf(fieldOf(block, "content"), "type")).endsWith("_error"),
  parts: ({ tool_use_id, content }) => [
    { id: "content", label: "content", kind: "json", value: content },
    { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
  ],
};
const ofSource = (of: Medium): Entry<Sourced<string>> => ({ fields: { source }, category: byRole, parts: (block, role) => sourceParts(block.source, of, role) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries: { [T in Type]: Entry<Extract<ContentBlock, { type: T }>> } = {
  text: { fields: { text: string }, category: byRole, parts: ({ text }, _, form) => [textPart(text, form)], stated: summarized },
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  thinking: {
    fields: { thinking: string, signature: optional(string) },
    category: thought,
    parts: ({ thinking, signature }) => [
      { id: "thinking", kind: "text", form: "markdown", text: thinking },
      { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
    ],
  },
  redacted_thinking: { fields: { data: string }, category: thought, parts: ({ data }) => [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] },
  tool_use: { ...toolUse(inputParts), stated: called },
  server_tool_use: toolUse((_, input) => jsonInput(input)),
  mcp_tool_use: toolUse((_, input) => jsonInput(input)),
  tool_result: toolResult,
  mcp_tool_result: toolResult,
  web_search_tool_result: serverToolResult,
  web_fetch_tool_result: serverToolResult,
  code_execution_tool_result: serverToolResult,
  bash_code_execution_tool_result: serverToolResult,
  text_editor_code_execution_tool_result: serverToolResult,
  tool_search_tool_result: serverToolResult,
  container_upload: { fields: {}, category: tools, parts: () => [] },
  image: ofSource("image"),
  document: ofSource("document"),
  search_result: {
    fields: { source: string, title: string, content },
    category: byRole,
    parts: ({ source, title, content }, role) => [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role)],
  },
};
const types = kinds.among(Object.keys(entries) as Type[]);

// [LAW:single-enforcer] The one reader of a content block: its type's declaration, by its `type`, or, for a type with no
// entry, the block as it was sent.
const variants = Object.fromEntries(Object.entries(entries).map(([type, entry]) => [type, entry.fields])) as Variants<"type", ContentBlock>;
const contentBlock = tagged<"type", ContentBlock, "unknown">("type", variants, mapped(asSent, () => "unknown" as const));
// What a block of a type with no entry states: nothing but the category of the message holding it.
const unknownFacts: Facts = { category: byRole };

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block its declaration
// refuses is shown the same way, with why, and still states what its own fields say.
export const formatBlock = (block: unknown, role: Role, form: Form): Block => blockOf(block, role, form, whole);
function blockOf(block: unknown, role: Role, form: Form, soFar: SoFar): Block {
  const sent = fieldOf(block, "type");
  const type = typeof sent === "string" ? sent : "block";
  const facts: Facts = types.fits(sent) ? entries[sent] : unknownFacts;
  const stating: Block = { category: facts.category(role, block), ...shownOf(block, type, role, form, soFar), ...facts.stated?.(block, role) };
  // A tool's result that says its tool failed is named for it.
  return facts.failed?.(block) ? { ...stating, name: `${stating.name}: error`, failed: true } : stating;
}

// A block's name and parts: its entry's, its unread fields after them; raw where it has no entry or its entry refuses it.
function shownOf(block: unknown, type: string, role: Role, form: Form, soFar: SoFar): Pick<Block, "name" | "parts"> {
  const read = readShown(contentBlock, block);
  if ("refused" in read) return { name: type, parts: receivedParts(read.refused, { kind: "json", value: block }) };
  if (read.value === "unknown") return { name: type, parts: [{ id: "block", kind: "json", value: block }] };
  // [LAW:types-are-the-program] The entry of the type `contentBlock` read the block by, so it takes that type's block.
  const entry = entries[read.value.type] as Entry<ContentBlock>;
  return { name: entry.name?.(read.value) ?? type, parts: [...entry.parts(read.value, role, form, soFar), ...unreadParts(read.unread)] };
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export const formatContent = (block: unknown, role: Role): Block[] => contentOf(block, role, whole);
// A block of a reply still arriving, as far as it has come: its tool input, where it has one, the JSON text sent so far.
export const formatArriving = (block: unknown, input: string): Block[] => contentOf(block, "assistant", { is: "arriving", input });
function contentOf(block: unknown, role: Role, soFar: SoFar): Block[] {
  const formatted = blockOf(block, role, "markdown", soFar);
  if (!isText(block)) return [formatted];
  const fields = formatted.parts.filter(({ id }) => id !== textId);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](block.text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const last = index === textPieces.length - 1;
    const rest = last ? fields : [];
    const parts: Part[] = [textPart(piece.text, form), ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, formatted.category, formatted.name, parts), preview: [textPart(piece.content, form), ...rest], ...(last ? stated : {}) };
  });
}

function isText(block: unknown): block is { type: "text"; text: string } {
  return typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
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

// The content of a tool result, a document or a search result, as parts: a text, or the parts of its blocks, each named
// under its block's index in the list, which only grows at its end. Its text is what the tool or the source returned,
// read verbatim.
function contentParts(content: Content, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}

// An image's or a document's source as parts: media the view shows, the text a text document holds, the blocks of a
// content document, or a source of a type not here by its type, its other fields among its block's unread fields.
function sourceParts(source: SourceRead | { other: string }, of: Medium, role: Role): Part[] {
  if ("other" in source) return [{ id: "source", label: "source", kind: "fields", fields: [["type", source.other]] }];
  switch (source.type) {
    case "base64":
    case "url":
    case "file":
      return [{ id: "source", kind: "media", of, source }];
    case "text":
      return [{ id: "source", kind: "text", form: "verbatim", text: source.data }];
    case "content":
      return contentParts(source.content, role);
  }
}
