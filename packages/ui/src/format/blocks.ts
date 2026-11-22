import { split, type Piece } from "./injected.ts";
import { restParts, fieldValue, receivedParts, type Field, type Form, type Medium, type Part, type PartBody, type Received } from "./parts.ts";
import { attempt, fieldOf, kinds, object, optional, parse, raw as asIs, value, type Kept, type Readers } from "@cc-dump/log/json";
import { Malformed } from "@cc-dump/log/failure";
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

// An error the API returned, as the body of an HTTP error or an event of a stream, with the fields beside it no read
// asked for: it stands where the reply would have.
export function formatError({ fields: { error }, rest }: Kept<{ error: unknown }>): Block {
  return { category: "assistant", name: "error", parts: [{ id: "error", kind: "json", value: error }, ...unreadParts(rest)] };
}
// The readers of an error's fields.
export const errorReaders = { error: asIs };

// The fields of an object no read asked for, as a part, when there are any.
export const unreadParts = (rest: Record<string, unknown>) => restParts(rest, unreadPart);

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(rest: Record<string, unknown>, category: Category, name: string): BlockOrNone {
  const parts = unreadParts(rest);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// What an entry shows of a block: its name, where it is not the block's type, and its parts.
type Shown = { name?: string; parts: Part[] };

// How one content block type is shown. `category` from the role of the message holding it and the block as sent, so a
// block its entry cannot read has the same one; `show`, its name and parts, read off its fields (`reading`). `form`: how
// a text block's text reads where the block is: Markdown in a message, verbatim in what a tool or a document returned.
// `failed`: whether a tool's result says its tool failed, read off the block as sent, so one its entry cannot read says
// so too. `stated`: what the block states that a thread stands after (Stated), read off the block as sent too.
type Entry = {
  category: (role: Role, block: unknown) => Category;
  show: (block: unknown, type: string, role: Role, form: Form) => Shown;
  failed?: (block: unknown) => boolean;
  stated?: (block: unknown, role: Role) => Stated;
};

// The show of a block of `type` whose fields `readers` read, each as the type it must have, or refused naming the type:
// `show`'s name and parts from them, then the fields they do not read, so a field the API adds is shown.
function reading<T>(readers: Readers<T>, show: (fields: T & { type: string }, role: Role, form: Form) => Shown): Entry["show"] {
  const read = object<T & { type: string }>({ ...readers, type: text } as Readers<T & { type: string }>, "keep");
  return (block, type, role, form) => {
    const { fields, rest } = parse(read, block, type);
    const shown = show(fields, role, form);
    return { ...shown, parts: [...shown.parts, ...unreadParts(rest)] };
  };
}

const text = value(kinds.string);

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
const toolUse = (read: (name: string, input: unknown) => Part[]): Entry => ({
  category: tools,
  show: reading({ name: text, id: text, input: optional(asIs) }, ({ type, name, id, input }) => ({
    name: `${type}: ${name}`,
    // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is:
    // the input's deltas' `partial_json`, joined, another text than the input it becomes.
    parts: [
      ...(typeof input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input } as const] : read(name, input)),
      { id: "id", kind: "fields", fields: [["id", id]] },
    ],
  })),
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call with no id is shown as not fitting (`toolUse`), and states none.
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

// What a client tool's result states: the call it answers, and the agent its texts name. One with no id is shown as not
// fitting (`toolResult`), and states none.
const answered = (block: unknown): Stated => {
  const id = fieldOf(block, "tool_use_id");
  const content = fieldOf(block, "content");
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((one) => (typeof fieldOf(one, "text") === "string" ? [fieldOf(one, "text") as string] : [])) : [];
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
const toolResult: Entry = {
  category: tools,
  stated: answered,
  failed: (block) => fieldOf(block, "is_error") === true,
  show: reading({ content: optional(asIs), is_error: optional(asIs), tool_use_id: text }, ({ content, is_error: failed, tool_use_id }, role) => {
    const id: Field[] = [["tool_use_id", tool_use_id], ...(failed === undefined ? [] : [["is_error", fieldValue(failed)] satisfies Field])];
    return { parts: [...(content === undefined ? [] : contentParts(content, role)), { id: "tool_use_id", kind: "fields", fields: id }] };
  }),
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry = {
  category: tools,
  failed: (block) => String(fieldOf(fieldOf(block, "content"), "type")).endsWith("_error"),
  show: reading({ content: optional(asIs), tool_use_id: text }, ({ content, tool_use_id }) => ({
    parts: [
      { id: "content", label: "content", kind: "json", value: content },
      { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
    ],
  })),
};
const ofSource = (of: Medium): Entry => ({ category: byRole, show: reading({ source: asIs }, ({ source }, role) => ({ parts: sourceParts(source, of, role) })) });

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, show: reading({ text }, ({ text }, _, form) => ({ parts: [textPart(text, form)] })), stated: summarized }],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      category: thought,
      show: reading({ thinking: text, signature: optional(text) }, ({ thinking, signature }) => ({
        parts: [
          { id: "thinking", kind: "text", form: "markdown", text: thinking },
          { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
        ],
      })),
    },
  ],
  ["redacted_thinking", { category: thought, show: reading({ data: text }, ({ data }) => ({ parts: [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] })) }],
  ["tool_use", { ...toolUse(inputParts), stated: called }],
  ["server_tool_use", toolUse((_, input) => jsonInput(input))],
  ["mcp_tool_use", toolUse((_, input) => jsonInput(input))],
  ["tool_result", toolResult],
  ["mcp_tool_result", toolResult],
  ["web_search_tool_result", serverToolResult],
  ["web_fetch_tool_result", serverToolResult],
  ["code_execution_tool_result", serverToolResult],
  ["bash_code_execution_tool_result", serverToolResult],
  ["text_editor_code_execution_tool_result", serverToolResult],
  ["tool_search_tool_result", serverToolResult],
  ["container_upload", { category: tools, show: reading({}, () => ({ parts: [] })) }],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    {
      category: byRole,
      show: reading({ source: text, title: text, content: asIs }, ({ source, title, content }, role) => ({
        parts: [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role)],
      })),
    },
  ],
]);

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block its entry cannot
// read is shown the same way, with why.
export function formatBlock(block: unknown, role: Role, form: Form): Block {
  const type = typeof block === "object" && block !== null && "type" in block && typeof block.type === "string" ? block.type : "block";
  const entry = entries.get(type);
  if (entry === undefined) return { category: byRole(role), name: type, parts: [{ id: "block", kind: "json", value: block }] };
  const shown = attempt(
    (): Block => {
      const { name, parts } = entry.show(block, type, role, form);
      return { category: entry.category(role, block), name: name ?? type, parts };
    },
    (reason) => raw(entry.category(role, block), type, reason, { kind: "json", value: block }),
  );
  const stating = { ...shown, ...entry.stated?.(block, role) };
  // A tool's result that says its tool failed is named for it.
  return entry.failed?.(block) ? { ...stating, name: `${stating.name}: error`, failed: true } : stating;
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(block: unknown, role: Role): Block[] {
  const formatted = formatBlock(block, role, "markdown");
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

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows, each
// named under its block's index in the list, which only grows at its end. Its text is what the tool or the source
// returned, read verbatim.
function contentParts(content: unknown, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  if (Array.isArray(content)) return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
  throw new Malformed("content is neither a string nor a list of blocks");
}

const typed = object({ type: text }, "keep");

// An image's or a document's source: media the view shows, the text a text document holds, or the blocks of a
// content document, by its type, which is read first. A source of another type is shown as its JSON.
function sourceParts(source: unknown, of: Medium, role: Role): Part[] {
  const { fields: { type }, rest } = parse(typed, source, "source");
  // The parts of a source whose other fields `readers` read, then the fields they do not read.
  const shown = <T,>(readers: Readers<T>, parts: (fields: T) => Part[]): Part[] => {
    const read = parse(object(readers, "keep"), rest, "source");
    return [...parts(read.fields), ...restParts(read.rest, { id: "source/unread", label: "source fields" })];
  };
  switch (type) {
    case "base64":
      return shown({ media_type: text, data: text }, (fields) => [{ id: "source", kind: "media", of, source: { type, ...fields } }]);
    case "url":
      return shown({ url: text }, (fields) => [{ id: "source", kind: "media", of, source: { type, ...fields } }]);
    case "file":
      return shown({ file_id: text }, (fields) => [{ id: "source", kind: "media", of, source: { type, ...fields } }]);
    case "text":
      return shown({ data: text }, ({ data }) => [{ id: "source", kind: "text", form: "verbatim", text: data }]);
    case "content":
      return shown({ content: asIs }, ({ content }) => contentParts(content, role));
    // A source of a type not here: its other fields follow.
    default:
      return shown({}, () => [{ id: "source", label: "source", kind: "fields", fields: [["type", type]] }]);
  }
}
