import { fields, held, kinds, list, nullable, optional, raw as asIs, readShown, refusalOf, union, value, whole, type Fields, type Other, type Reader, type Readers, type Shown, type Tagged, type Unread, type Variants } from "@cc-dump/log/json";
import { Malformed } from "@cc-dump/log/failure";
import { split, type Piece } from "./injected.ts";
import { fieldValue, receivedParts, restParts, unreadParts, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import type { Fields as ReadFields } from "./read.ts";
import { called, calledAsJson, type Called } from "./tools.ts";
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

// The part holding a block's fields no declaration names.
export const unreadPart = { id: "unread", label: "fields" };

// The fields of an object no declaration names, as a block of their own in `category`, when there are any.
export function unreadBlock(unread: readonly Unread[], category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unread, [], unreadPart);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Received): Block {
  return { category, name, parts: receivedParts(reason, received) };
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
export function formatError(fields: ReadFields): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: fields.value("error") }, ...restOf(fields)] };
}

const restOf = (fields: ReadFields) => restParts(fields.rest(), unreadPart);

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(fields: ReadFields, category: Category, name: string): BlockOrNone {
  const parts = restOf(fields);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// [LAW:one-source-of-truth] A cache breakpoint is the request's, not the block it is set on: the cache's prefix is built
// from the tools, then the system prompt, then the messages, and Claude Code moves the breakpoints to the newest blocks
// on every request, so a block shown holding one would differ each time it is resent. Every block and tool declares
// it, so the request collects each from the block's read (format.ts), and no block shows it.
export type Breakpoint = { cache_control?: unknown };
export const breakpoint: Readers<Breakpoint> = { cache_control: optional(asIs) };
export const breakpointsOf = (read: Partial<Breakpoint>): unknown[] => (Object.hasOwn(read, "cache_control") ? [read.cache_control] : []);

// An object as it was sent, less its breakpoint: what a block that does not read, or of a type with no entry, shows.
export const asSent = ({ sent }: Fields<Breakpoint>): unknown => Object.fromEntries(Object.entries(sent).filter(([key]) => !Object.hasOwn(breakpoint, key)));

// [LAW:types-are-the-program] A content block read: of a type this build has an entry for, by that type's fields, or of
// another, by its breakpoint alone; or, not an object or with no type, refused.
export type Content = Shown<ContentRead>;
type ContentRead = Tagged<ContentVariants> | Other<Fields<Breakpoint>>;
// What a tool, a source or a message holds as its content: a string, the text of one text block, or content blocks.
export type Contents = string | readonly Content[];

interface ToolResult extends Breakpoint {
  tool_use_id: string;
  content?: Contents;
  is_error?: boolean;
}
interface OfSource extends Breakpoint {
  source: SourceRead;
}
interface SearchResult extends Breakpoint {
  source: string;
  title: string;
  content: Contents;
}
interface SourceContent {
  content: Contents;
}
type ToolUse = Breakpoint & { id: string; name: string; input: unknown };
type ServerToolResult = Breakpoint & { tool_use_id: string; content: unknown };

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, by its type, with its fields.
type ContentVariants = {
  text: Breakpoint & { text: string; citations?: readonly unknown[] | null };
  thinking: Breakpoint & { thinking: string; signature?: string };
  redacted_thinking: Breakpoint & { data: string };
  tool_use: ToolUse;
  server_tool_use: ToolUse;
  mcp_tool_use: ToolUse;
  tool_result: ToolResult;
  mcp_tool_result: ToolResult;
  web_search_tool_result: ServerToolResult;
  web_fetch_tool_result: ServerToolResult;
  code_execution_tool_result: ServerToolResult;
  bash_code_execution_tool_result: ServerToolResult;
  text_editor_code_execution_tool_result: ServerToolResult;
  tool_search_tool_result: ServerToolResult;
  container_upload: Breakpoint;
  image: OfSource;
  document: OfSource;
  search_result: SearchResult;
};

// [LAW:types-are-the-program] An image's or a document's source, by its type: media the view shows, the text a text
// document holds, or the blocks of a content document; or one of another type, by its type alone.
type SourceVariants = {
  base64: { media_type: string; data: string };
  url: { url: string };
  file: { file_id: string };
  text: { data: string };
  content: SourceContent;
};
type SourceRead = Tagged<SourceVariants> | Other<Fields<{ type: string }>>;

const string = value(kinds.string);

// [LAW:parse-dont-validate] A content field: a string, or content blocks, each holding its own refusal, so one block
// that does not read costs only itself.
export const contents: Reader<Contents> = (json, at) => {
  if (typeof json === "string") return string(json, at);
  if (Array.isArray(json)) return list(held(contentBlock))(json, at);
  throw new Malformed("is not a string or a list of blocks");
};

const source = union<"type", SourceVariants, Fields<{ type: string }>>(
  "type",
  { base64: { media_type: string, data: string }, url: { url: string }, file: { file_id: string }, text: { data: string }, content: { content: contents } },
  fields({ type: string }),
);

// How a block of one type is shown, from its fields as read, whichever refused: its category, by its type and the role
// of the message holding it, so a block whose field does not read keeps it; its name, where it is not its type; what
// it states (Stated) and whether it says its tool failed; and its parts, from the block read whole. `form`: how a text
// block's text reads where the block is: Markdown in a message, verbatim in what a tool or a document returned.
type Shows<F> = Stated & { category: Category; name?: string; failed?: true; parts: (block: F) => Part[] };
type Entry<F> = { readonly fields: Readers<F>; readonly show: (read: Partial<F>, role: Role, form: Form) => Shows<F> };
type Entries = { readonly [T in keyof ContentVariants]: Entry<ContentVariants[T]> };

const byRole = (role: Role) => roleCategory[role];

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (text: string | undefined, role: Role): Stated => {
  const summary = role === "assistant" && text !== undefined ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool use: a client tool's call, its input read by the tool's own shape (format/tools.ts), or a server tool's or an
// MCP server's, whose names are their own and may be any, its input as its JSON. A client tool's call states what it
// launches, from that one read of its input, and whether its reply waits for its result. A call whose id does not read
// states none.
const toolUse = (type: string, call: (name: string | undefined, input: unknown) => Called, states: boolean): Entry<ToolUse> => ({
  fields: { ...breakpoint, id: string, name: string, input: asIs },
  show: ({ id, name, input }) => {
    const { parts, launches } = call(name, input);
    const stated: Stated = states && id !== undefined ? { call: { id, launches, waits: name !== "SubagentHandback" } } : {};
    return { category: "tools", ...stated, ...(name === undefined ? {} : { name: `${type}: ${name}` }), parts: (block) => [...parts, { id: "id", kind: "fields", fields: [["id", block.id]] }] };
  },
});
const clientCall = (name: string | undefined, input: unknown): Called => (name === undefined ? calledAsJson(input) : called(name, input));

// The texts a tool's content holds: the string, or each of its blocks' text.
function textsOf(content: Contents | undefined): string[] {
  if (typeof content === "string") return [content];
  return (content ?? []).flatMap((block) => (block.is === "read" && block.read.value.is === "known" && block.read.value.tag === "text" && block.read.value.fields.value.text !== undefined ? [block.read.value.fields.value.text] : []));
}

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent. It states the call it answers, and the agent its texts name.
const toolResult: Entry<ToolResult> = {
  fields: { ...breakpoint, tool_use_id: string, content: optional(contents), is_error: optional(value(kinds.boolean)) },
  show: ({ tool_use_id, content, is_error }, role) => ({
    category: "tools",
    ...(tool_use_id === undefined ? {} : { result: { answers: tool_use_id, names: namedIn(textsOf(content)) } }),
    ...(is_error === true ? { failed: true } : {}),
    parts: (block) => {
      const id: Field[] = [["tool_use_id", block.tool_use_id], ...(block.is_error === undefined ? [] : [["is_error", fieldValue(block.is_error)] satisfies Field])];
      return [...(block.content === undefined ? [] : contentParts(block.content, role)), { id: "tool_use_id", kind: "fields", fields: id }];
    },
  }),
};

// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each; its results are a list.
const errorType = fields<{ type?: string }>({ type: optional(string) });
const isError = (content: unknown): boolean => {
  const read = readShown(errorType, content);
  return read.is === "read" && (read.read.value.value.type?.endsWith("_error") ?? false);
};
const serverToolResult: Entry<ServerToolResult> = {
  fields: { ...breakpoint, tool_use_id: string, content: asIs },
  show: ({ content }) => ({
    category: "tools",
    ...(isError(content) ? { failed: true } : {}),
    parts: (block) => [
      { id: "content", label: "content", kind: "json", value: block.content },
      { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", block.tool_use_id]] },
    ],
  }),
};

const ofSource = (of: Medium): Entry<OfSource> => ({
  fields: { ...breakpoint, source },
  show: (_, role) => ({ category: byRole(role), parts: (block) => sourceParts(block.source, of, role) }),
});

// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3). A streamed thinking block has no signature
// until its signature delta, just before its stop.
const entries: Entries = {
  text: {
    fields: { ...breakpoint, text: string, citations: optional(nullable(list(asIs))) },
    show: ({ text }, role, form) => ({
      category: byRole(role),
      ...summarized(text, role),
      parts: (block) => [textPart(block.text, form), ...(block.citations === undefined || block.citations === null ? [] : [{ id: "citations", label: "citations", kind: "json" as const, value: block.citations }])],
    }),
  },
  thinking: {
    fields: { ...breakpoint, thinking: string, signature: optional(string) },
    show: ({ thinking }) => ({
      category: thinking === "" ? "usage" : "thinking",
      parts: (block) => [
        { id: "thinking", kind: "text", form: "markdown", text: block.thinking },
        { id: "signature", kind: "fields", fields: [["signature", block.signature === undefined ? "none" : `${block.signature.length} characters`]] },
      ],
    }),
  },
  redacted_thinking: {
    fields: { ...breakpoint, data: string },
    show: () => ({ category: "usage", parts: (block) => [{ id: "data", kind: "fields", fields: [["data", `${block.data.length} characters`]] }] }),
  },
  tool_use: toolUse("tool_use", clientCall, true),
  server_tool_use: toolUse("server_tool_use", (_, input) => calledAsJson(input), false),
  mcp_tool_use: toolUse("mcp_tool_use", (_, input) => calledAsJson(input), false),
  tool_result: toolResult,
  mcp_tool_result: toolResult,
  web_search_tool_result: serverToolResult,
  web_fetch_tool_result: serverToolResult,
  code_execution_tool_result: serverToolResult,
  bash_code_execution_tool_result: serverToolResult,
  text_editor_code_execution_tool_result: serverToolResult,
  tool_search_tool_result: serverToolResult,
  container_upload: { fields: breakpoint, show: () => ({ category: "tools", parts: () => [] }) },
  image: ofSource("image"),
  document: ofSource("document"),
  search_result: {
    fields: { ...breakpoint, source: string, title: string, content: contents },
    show: (_, role) => ({
      category: byRole(role),
      parts: (block) => [{ id: "search result", kind: "fields", fields: [["source", block.source], ["title", block.title]] }, ...contentParts(block.content, role)],
    }),
  },
};

// The readers of each type's fields, from its entry.
function variantsOf<V>(entries: { readonly [T in keyof V & string]: { readonly fields: Readers<V[T]> } }): Variants<V> {
  // [LAW:types-are-the-program] exception: a map over a record's keys keeps each key's own type, which TypeScript
  // cannot follow through Object.entries.
  return Object.fromEntries(Object.entries<{ readonly fields: unknown }>(entries).map(([type, entry]) => [type, entry.fields])) as Variants<V>;
}

// [LAW:single-enforcer] The one read of a content block: its type's fields, or, for a type with no entry, its
// breakpoint.
const contentBlock = union<"type", ContentVariants, Fields<Breakpoint>>("type", variantsOf<ContentVariants>(entries), fields(breakpoint));

// A content block as sent, read.
export const contentOf = (json: unknown): Content => readShown(contentBlock, json);

// The blocks a content field holds: a string is the text of one text block.
export const blocksOf = (contents: Contents): readonly Content[] => (typeof contents === "string" ? [contentOf({ type: "text", text: contents })] : contents);

// The cache breakpoint a content block holds, as it was read, whatever else of the block did not.
export function breakpointOf(content: Content): unknown[] {
  if (content.is === "refused") return [];
  const read = content.read.value;
  return breakpointsOf(read.is === "other" ? read.other.value : read.fields.value);
}

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A block that is not an object or has no type is shown as its raw JSON, with why; a type with
// no entry as its raw JSON under its type name; and a block holding a field that does not read, its parts as its raw
// JSON, with why, while it keeps the category, the name and what it states from the fields that read.
export function formatBlock(content: Content, role: Role, form: Form): Block {
  if (content.is === "refused") return raw(byRole(role), "block", content.why, { kind: "json", value: content.sent });
  const read = content.read.value;
  return read.is === "other" ? { category: byRole(role), name: read.tag, parts: [{ id: "block", kind: "json", value: asSent(read.other) }] } : formatKnown(read, role, form);
}

// [LAW:types-are-the-program] A block of a type with an entry, by that entry: its tag names the entry its fields were read by.
function formatKnown<T extends keyof ContentVariants>(read: { readonly tag: T; readonly fields: Fields<ContentVariants[T]> }, role: Role, form: Form): Block {
  const entry: Entry<ContentVariants[T]> = entries[read.tag];
  const { refused, unread, value } = read.fields;
  const { category, name, failed, parts, ...stated } = entry.show(value, role, form);
  const shown: Part[] = refused.length === 0 ? [...parts(whole(read.fields, [])), ...unreadParts(unread, [], unreadPart)] : receivedParts(refusalOf(refused, []), { kind: "json", value: asSent(read.fields) });
  const named = name ?? read.tag;
  // A tool's result that says its tool failed is named for it.
  return { category, name: failed ? `${named}: error` : named, parts: shown, ...stated, ...(failed ? { failed } : {}) };
}

// The text of a text block whose every field read: what its pieces split.
function textOf(content: Content): string | undefined {
  if (content.is === "refused" || content.read.value.is === "other" || content.read.value.tag !== "text") return undefined;
  const { refused, value } = content.read.value.fields;
  return refused.length === 0 ? value.text : undefined;
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(content: Content, role: Role): Block[] {
  const block = formatBlock(content, role, "markdown");
  const text = textOf(content);
  if (text === undefined) return [block];
  const fields = block.parts.filter(({ id }) => id !== textId);
  const stated: Stated = block.summary === undefined ? {} : { summary: block.summary };
  const textPieces = pieces[role](text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const last = index === textPieces.length - 1;
    const rest = last ? fields : [];
    const parts: Part[] = [textPart(piece.text, form), ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, block.category, block.name, parts), preview: [textPart(piece.content, form), ...rest], ...(last ? stated : {}) };
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

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows, each
// named under its block's index in the list, which only grows at its end. Its text is what the tool or the source
// returned, read verbatim.
function contentParts(content: Contents, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}

// The part holding a source's fields no declaration names.
const sourceUnread = { id: "source/unread", label: "source fields" };

// An image's or a document's source: media the view shows, the text a text document holds, or the blocks of a content
// document. A source of another type is shown by its type, its other fields following. One holding a field that does
// not read is shown as its raw JSON, with why.
function sourceParts(source: SourceRead, of: Medium, role: Role): Part[] {
  if (source.is === "other") return [{ id: "source", label: "source", kind: "fields", fields: [["type", source.tag]] }, ...unreadParts(source.other.unread, ["source"], sourceUnread)];
  const { refused, sent, unread } = source.fields;
  if (refused.length > 0) return receivedParts(refusalOf(refused, []), { kind: "json", value: sent });
  return [...knownSource(source, of, role), ...unreadParts(unread, ["source"], sourceUnread)];
}

function knownSource(source: Tagged<SourceVariants>, of: Medium, role: Role): Part[] {
  switch (source.tag) {
    case "base64": {
      const { media_type, data } = whole(source.fields, []);
      return [{ id: "source", kind: "media", of, source: { type: source.tag, media_type, data } }];
    }
    case "url":
      return [{ id: "source", kind: "media", of, source: { type: source.tag, url: whole(source.fields, []).url } }];
    case "file":
      return [{ id: "source", kind: "media", of, source: { type: source.tag, file_id: whole(source.fields, []).file_id } }];
    case "text":
      return [{ id: "source", kind: "text", form: "verbatim", text: whole(source.fields, []).data }];
    case "content":
      return contentParts(whole(source.fields, []).content, role);
  }
}
