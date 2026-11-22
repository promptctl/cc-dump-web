import { fieldOf, held, kinds, object, optional, raw, tagged, value, type Held, type Kind, type Path, type Readers, type Refusal, type Unknown } from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { fieldValue, receivedParts, unknownParts, valuePart, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import { callOf, inputParts, jsonInput, type Launch } from "./tools.ts";
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

// A value its reader refused, shown as it was received, its JSON or its text, with why.
export function refusedBlock(category: Category, name: string, refusals: readonly Refusal[], received: Received): Block {
  return { category, name, parts: receivedParts(refusals, received) };
}

// [LAW:nothing-unseen] The fields of a value read at `at` that no declaration names, as the part that shows them, when
// there are any.
export const unreadParts = (unknown: readonly Unknown[], at: Path) => unknownParts(unknown, at, { id: "unread", label: "fields" });

// The fields of a value read at `at` that no declaration names, as a block of their own in `category`, when there are any.
export function unreadBlock(unknown: readonly Unknown[], at: Path, category: Category, name: string): BlockOrNone {
  const parts = unreadParts(unknown, at);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// An error the API returned, as the body of an HTTP error or an event of a stream, and the fields beside it no
// declaration names: it stands where the reply would have.
export const errorBlock = (error: unknown, unread: Part[]): Block => ({ category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unread] });

// [LAW:types-are-the-program] A block's fields as read, each its value or its refusal, in its own place.
type Fields<T> = { readonly [K in keyof T]: Held<T[K]> };

// What a held field read as, or none, for a fact a block states only from a field that reads.
const readOf = <T>(field: Held<T>): T | undefined => (field.is === "read" ? field.value : undefined);

// [LAW:parse-dont-validate] The values of the fields `names` when each reads, or every refusal among them, with what
// was sent.
function whole<T>(fields: Fields<T>, names: readonly (keyof T & string)[], sent: unknown): Held<T> {
  const read = names.map((name): [string, Held<unknown>] => [name, fields[name]]);
  const refusals = read.flatMap(([, field]) => (field.is === "refused" ? field.refusals : []));
  return refusals.length > 0 ? { is: "refused", refusals, sent } : { is: "read", value: Object.fromEntries(read.map(([name, field]) => [name, readOf(field)])) as T };
}

// How one content block type is shown. `fields`: the readers of the fields it shows, each held, so a field that does
// not read costs the block its parts, shown as received with why, and nothing else: its category, its name, whether
// its tool failed and what it states (Stated) come from the fields that read. `parts` and `name` from its fields once
// every one reads; the fields no declaration names are shown after its parts. `form`: how a text block's text reads
// where the block is: Markdown in a message, verbatim in what a tool or a document returned.
type Entry<T> = {
  fields: Readers<T>;
  category: (role: Role, fields: Fields<T>) => Category;
  name?: (fields: T, type: string) => string;
  parts: (fields: T, at: Path, role: Role, form: Form) => Part[];
  failed?: (fields: Fields<T>) => boolean;
  stated?: (fields: Fields<T>, role: Role) => Stated;
};

// A content block of the type `type`, at `at`, as the block the view shows.
type Format = (block: Record<string, unknown>, type: string, at: Path, role: Role, form: Form) => Block;

// [LAW:single-enforcer] The one read of a content block's fields, whatever its entry declares: each field it declares
// held, and its type, which picked the entry, read already.
function entry<T>({ fields, category, name, parts, failed, stated }: Entry<T>): Format {
  const names = Object.keys(fields) as (keyof T & string)[];
  const reader = object(Object.fromEntries([...names.map((name) => [name, held(fields[name])]), ["type", raw]]) as Readers<Fields<T> & { type: unknown }>);
  return (block, type, at, role, form) => {
    // Every field is held and the block is an object, so the read is never refused.
    const { value: read, unknown } = reader(block, at);
    const shown = whole(read, names, block);
    const formatted: Block =
      shown.is === "read"
        ? { category: category(role, read), name: name?.(shown.value, type) ?? type, parts: [...parts(shown.value, at, role, form), ...unreadParts(unknown, at)] }
        : refusedBlock(category(role, read), type, shown.refusals, { kind: "json", value: block });
    const stating = { ...formatted, ...stated?.(read, role) };
    // A tool's result that says its tool failed is named for it.
    return failed?.(read) ? { ...stating, name: `${stating.name}: error`, failed: true } : stating;
  };
}

const text = value(kinds.string);
const sent = value(kinds.sent);
// A tool's result's, a document's or a search result's content: its text, or its content blocks.
const contentKind: Kind<string | unknown[]> = { fits: (json): json is string | unknown[] => typeof json === "string" || Array.isArray(json), expected: "a string or a list of blocks" };
const content = value(contentKind);

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thought = (_: Role, { thinking }: Fields<{ thinking: string }>): Category => (readOf(thinking) ? "thinking" : "usage");

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON.
type Use = { id: string; name: string; input: unknown };
const toolUse = (read: (name: string, input: unknown, at: Path) => Part[]): Entry<Use> => ({
  fields: { id: text, name: text, input: sent },
  category: tools,
  name: ({ name }, type) => `${type}: ${name}`,
  parts: ({ id, name, input }, at) => {
    // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is:
    // the input's deltas' `partial_json`, joined, another text than the input it becomes.
    const parts: Part[] = typeof input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input }] : read(name, input, [...at, "input"]);
    return [...parts, { id: "id", kind: "fields", fields: [["id", id]] }];
  },
});
// A client tool's call, by the tool, states what it launches and whether it is waited on (format/tools.ts). A call
// whose id does not read states none.
const called = ({ id, name, input }: Fields<Use>): Stated => {
  const ids = readOf(id);
  const tool = readOf(name);
  return ids === undefined ? {} : { call: { id: ids, ...(tool === undefined ? { launches: undefined, waits: true } : callOf(tool, readOf(input))) } };
};

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
type Text = { text: string; citations: unknown[] | undefined };
const summarized = ({ text }: Fields<Text>, role: Role): Stated => {
  const said = readOf(text);
  const summary = role === "assistant" && said !== undefined ? summaryEnding.exec(said)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent. What it states: the call it answers, and the agent its texts name; one whose
// id does not read states none.
type Result = { tool_use_id: string; content: string | unknown[] | undefined; is_error: unknown };
const toolResult: Entry<Result> = {
  fields: { tool_use_id: text, content: optional(content), is_error: raw },
  category: tools,
  failed: ({ is_error }) => readOf(is_error) === true,
  stated: ({ tool_use_id, content }) => {
    const answers = readOf(tool_use_id);
    const said = readOf(content);
    const texts = typeof said === "string" ? [said] : (said ?? []).flatMap((block) => [fieldOf(block, "text")].filter(kinds.string.fits));
    return answers === undefined ? {} : { result: { answers, names: namedIn(texts) } };
  },
  parts: ({ tool_use_id, content, is_error }, at, role) => {
    const id: Field[] = [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])];
    return [...(content === undefined ? [] : contentParts(content, [...at, "content"], role)), { id: "tool_use_id", kind: "fields", fields: id }];
  },
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry<{ tool_use_id: string; content: unknown }> = {
  fields: { tool_use_id: text, content: sent },
  category: tools,
  failed: ({ content }) => [fieldOf(readOf(content), "type")].filter(kinds.string.fits).some((type) => type.endsWith("_error")),
  parts: ({ tool_use_id, content }) => [
    { id: "content", label: "content", kind: "json", value: content },
    { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
  ],
};
const ofSource = (of: Medium): Entry<{ source: unknown }> => ({ fields: { source: sent }, category: byRole, parts: ({ source }, at, role) => sourceParts(source, of, role, [...at, "source"]) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name. A Map, so a type of any name, `__proto__` among them, is looked up as sent.
const formats = new Map<string, Format>([
  [
    "text",
    entry<Text>({
      fields: { text, citations: optional(value(kinds.list)) },
      category: byRole,
      parts: ({ text, citations }, _, __, form) => [textPart(text, form), ...(citations === undefined ? [] : [{ ...valuePart(citations, "citations"), label: "citations" }])],
      stated: summarized,
    }),
  ],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    entry<{ thinking: string; signature: string | undefined }>({
      fields: { thinking: text, signature: optional(text) },
      category: thought,
      parts: ({ thinking, signature }) => [
        { id: "thinking", kind: "text", form: "markdown", text: thinking },
        { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
      ],
    }),
  ],
  ["redacted_thinking", entry<{ data: string }>({ fields: { data: text }, category: () => "usage", parts: ({ data }) => [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] })],
  ["tool_use", entry({ ...toolUse(inputParts), stated: called })],
  ["server_tool_use", entry(toolUse((_, input) => jsonInput(input)))],
  ["mcp_tool_use", entry(toolUse((_, input) => jsonInput(input)))],
  ["tool_result", entry(toolResult)],
  ["mcp_tool_result", entry(toolResult)],
  ["web_search_tool_result", entry(serverToolResult)],
  ["web_fetch_tool_result", entry(serverToolResult)],
  ["code_execution_tool_result", entry(serverToolResult)],
  ["bash_code_execution_tool_result", entry(serverToolResult)],
  ["text_editor_code_execution_tool_result", entry(serverToolResult)],
  ["tool_search_tool_result", entry(serverToolResult)],
  ["container_upload", entry({ fields: {}, category: tools, parts: () => [] })],
  ["image", entry(ofSource("image"))],
  ["document", entry(ofSource("document"))],
  [
    "search_result",
    entry<{ source: string; title: string; content: string | unknown[] }>({
      fields: { source: text, title: text, content },
      category: byRole,
      parts: ({ source, title, content }, at, role) => [
        { id: "search result", kind: "fields", fields: [["source", source], ["title", title]] },
        ...contentParts(content, [...at, "content"], role),
      ],
    }),
  ],
]);

// A content block of a message in `role`, at `at` in its document, as the block the view shows, a text block's text
// read in `form`. [LAW:no-silent-failure] A block that is no object, or of a type with no entry, is shown as its raw
// JSON under its type name; a field its entry cannot read is shown as the block received, with why.
export function formatBlock(block: unknown, role: Role, form: Form, at: Path): Block {
  const type = fieldOf(block, "type");
  const format = kinds.string.fits(type) ? formats.get(type) : undefined;
  if (format === undefined || !kinds.object.fits(block)) return { category: byRole(role), name: kinds.string.fits(type) ? type : "block", parts: [{ id: "block", kind: "json", value: block }] };
  return format(block, type as string, at, role, form);
}

// A content block of a message in `role`, at `at`, as the blocks the view shows: the one block `formatBlock` makes, but
// for a text block whose text reads, which is a block for each piece of its text, each named for what it is, so what
// the harness injected is never shown as what was said (docs/design/01-features.md, F3), whatever its other fields
// hold. A text block's other parts follow its last piece, which states what the text ends with.
export function formatContent(block: unknown, role: Role, at: Path): Block[] {
  const formatted = formatBlock(block, role, "markdown", at);
  const said = fieldOf(block, "text");
  if (fieldOf(block, "type") !== "text" || !kinds.string.fits(said)) return [formatted];
  const fields = formatted.parts.filter(({ id }) => id !== textId);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](said);
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

// The content of a tool result, a document or a search result, at `at`: a string, or content blocks, whose parts it
// shows, each named under its block's index in the list, which only grows at its end. Its text is what the tool or the
// source returned, read verbatim.
function contentParts(content: string | unknown[], at: Path, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim", [...at, String(index)]).parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}

// [LAW:types-are-the-program] An image's or a document's source, by its type: media the view shows, the text a text
// document holds, or the blocks of a content document.
type Source =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }
  | { type: "file"; file_id: string }
  | { type: "text"; data: string }
  | { type: "content"; content: string | unknown[] };
const sources = { base64: { media_type: text, data: text }, url: { url: text }, file: { file_id: text }, text: { data: text }, content: { content } };
const source = tagged<"type", Source>("type", sources);
// A source of a type not among those: its type, and its other fields after.
const otherSource = object({ type: text });

// A source at `at` as the parts its block shows, then its fields no declaration names. [LAW:no-silent-failure] A
// source that does not read is shown as it was received, with why, in its block's place; the block's other fields
// still read.
function sourceParts(sent: unknown, of: Medium, role: Role, at: Path): Part[] {
  const type = fieldOf(sent, "type");
  const unread = (unknown: readonly Unknown[]) => unknownParts(unknown, at, { id: "source/unread", label: "source fields" });
  if (kinds.string.fits(type) && !Object.hasOwn(sources, type)) {
    const other = held(otherSource)(sent, at);
    return other.value.is === "read" ? [{ id: "source", label: "source", kind: "fields", fields: [["type", type]] }, ...unread(other.unknown)] : receivedParts(other.value.refusals, { kind: "json", value: sent });
  }
  const read = held(source)(sent, at);
  if (read.value.is === "refused") return receivedParts(read.value.refusals, { kind: "json", value: sent });
  const shown = read.value.value;
  const parts = ((): Part[] => {
    switch (shown.type) {
      case "base64":
        return [{ id: "source", kind: "media", of, source: shown }];
      case "url":
        return [{ id: "source", kind: "media", of, source: shown }];
      case "file":
        return [{ id: "source", kind: "media", of, source: shown }];
      case "text":
        return [{ id: "source", kind: "text", form: "verbatim", text: shown.data }];
      case "content":
        return contentParts(shown.content, [...at, "content"], role);
    }
  })();
  return [...parts, ...unread(read.unknown)];
}
