import { kinds, list, mapped, object, optional, picked, raw as asSent, readShown, string, tagged, tagOf, tolerant, value, type Attempt, type Kind, type Reader, type Readers, type Unread } from "@cc-dump/log/json";
import { split, type Piece } from "./injected.ts";
import { restParts, fieldValue, receivedParts, type Field, type Form, type Medium, type Part, type PartBody, type Received, type Source } from "./parts.ts";
import { sentSoFar, type Arriving, type Grows } from "./reply.ts";
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
// [LAW:one-source-of-truth] The roles read are those `roleCategory` gives a category, whose keys the compiler holds to Role.
export const role = kinds.among(Object.keys(roleCategory) as Role[]);
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
// [LAW:one-source-of-truth] A message's content and a system prompt as the blocks they are: a string is the text of one
// text block.
export const blockList: Reader<unknown[]> = mapped(content, (sent) => (typeof sent === "string" ? [{ type: "text", text: sent }] : sent));

// The type a value names, read on its own: what tells a block's entry, and a source's, from the others.
const typeName = object<{ type: string }>({ type: string });

// An image's or a document's source, by its type: media the view shows, the text a text document holds, the blocks of
// a content document, or, `unknown`, a source of a type not here, `named` by its type. No source the API sends is
// typed `unknown`, since a type it has no variant for reads to it.
type SourceRead = Source | { type: "text"; data: string } | { type: "content"; content: Content };
type UnknownSource = { type: "unknown"; named: string };
const source = tagged<"type", SourceRead, UnknownSource>(
  "type",
  { base64: { media_type: string, data: string }, url: { url: string }, file: { file_id: string }, text: { data: string }, content: { content } },
  mapped(typeName, ({ type }) => ({ type: "unknown", named: type })),
);

// [LAW:types-are-the-program] Every content block type the Messages API documents, each the fields it shows: a field
// not declared here is shown after its block's parts, as it was sent. A server tool result's content is its results, or
// an object of a type: its result's, or its tool's error.
type Text = { type: "text"; text: string; citations?: unknown[] };
type Thinking = { type: "thinking"; thinking: string; signature?: string };
type ToolUse<T extends string> = { type: T; id: string; name: string; input: unknown };
type ToolResult<T extends string> = { type: T; tool_use_id: string; content?: Content; is_error?: boolean };
type ServerContent = unknown[] | { type: string };
type ServerToolResult<T extends string> = { type: T; tool_use_id: string; content: ServerContent };
type Sourced<T extends string> = { type: T; source: SourceRead | UnknownSource };
type ContentBlock =
  | Text
  | Thinking
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
type BlockOf<T extends Type> = Extract<ContentBlock, { type: T }>;

// The declarations a fact is read by as well as a block (`fact`), each once.
const textFields: Readers<Omit<Text, "type">> = { text: string, citations: optional(list(asSent)) };
const thinkingFields: Readers<Omit<Thinking, "type">> = { thinking: string, signature: optional(string) };
const toolUseFields: Readers<Omit<ToolUse<string>, "type">> = { id: string, name: string, input: asSent };
const toolResultFields: Readers<Omit<ToolResult<string>, "type">> = { tool_use_id: string, content: optional(content), is_error: optional(value(kinds.boolean)) };
const serverContent: Kind<ServerContent> = {
  fits: (json): json is ServerContent => Array.isArray(json) || (kinds.object.fits(json) && kinds.string.fits(json.type)),
  expected: "a list of results, or an object of a type",
};
const serverToolResultFields: Readers<Omit<ServerToolResult<string>, "type">> = { tool_use_id: string, content: value(serverContent) };

// [LAW:single-enforcer] A fact a block states, read on the block as sent by its type's own readers of the fields `keys`
// that state it, never by the whole declaration, so a block its declaration refuses states it too: none where those
// fields do not read.
function fact<T, K extends keyof T, F>(fields: Readers<T>, keys: readonly K[], as: (value: Pick<T, K>) => F): (block: unknown) => F | undefined {
  const reader = object(picked(fields, keys));
  return (block) => {
    const read = readShown(reader, block);
    return read.is === "read" ? as(read.read.value) : undefined;
  };
}

// How one content block type is shown: its declaration, `fields`; its `name`, where it is not its type; and its `parts`.
// `form`: how a text block's text reads where the block is: Markdown in a message, verbatim in what a tool or a
// document returned. `soFar`: for a block of a reply still arriving, its tool input as the JSON text sent so far.
// `text`: the text a text block's pieces are split from (`formatContent`). `grows`: what its deltas grow while its
// stream sends it, none for a block its start sends whole. What a block states, read off it as sent, each fact by its own
// field (`fact`): `category` from the role of the message holding it; `failed`, whether a tool's result says its tool
// failed; `stated`, what a thread stands after (Stated).
type Fields<B> = Omit<B, "type">;
type Entry<B extends { type: string }> = {
  fields: Readers<Fields<B>>;
  name?: (block: Fields<B>, type: string) => string;
  parts: (block: Fields<B>, role: Role, form: Form, soFar: SoFar) => Part[];
  text?: (block: Fields<B>) => string;
  grows?: (block: Fields<B>) => Grows;
  category: (role: Role, block: unknown) => Category;
  failed?: (block: unknown) => boolean;
  stated?: (block: unknown, role: Role) => Stated;
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
const thought = fact(thinkingFields, ["thinking"], ({ thinking }) => thinking !== "");
const usage = () => "usage" as const;

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON. Its input streams as JSON text.
const toolUse = (read: (name: string, input: unknown) => Part[]): Entry<ToolUse<string>> => ({
  fields: toolUseFields,
  category: tools,
  name: (block, type) => `${type}: ${block.name}`,
  parts: ({ id, name, input }, _role, _form, soFar) => {
    // An input still arriving is shown as the text it is: its deltas' `partial_json`, joined, another text than the
    // input it becomes.
    const parts: Part[] = soFar.is === "arriving" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: soFar.input }] : read(name, input);
    return [...parts, { id: "id", kind: "fields", fields: [["id", id]] }];
  },
  grows: () => ({ by: "input", input: "" }),
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call with no id states none.
const launchInput = tolerant<{ subagent_type?: string; skill?: string }>({ subagent_type: optional(string), skill: optional(string) }, {});
const launchOf = (name: string | undefined, input: unknown): Launch | undefined => {
  const { subagent_type: type, skill } = launchInput(input, []).value;
  if (name === "Agent") return { tool: "Agent", type };
  return name === "Skill" && skill !== undefined ? { tool: "Skill", skill } : undefined;
};
const callId = fact(toolUseFields, ["id"], ({ id }) => id);
const callName = fact(toolUseFields, ["name"], ({ name }) => name);
const callInput = fact(toolUseFields, ["input"], ({ input }) => input);
const called = (block: unknown): Stated => {
  const id = callId(block);
  const name = callName(block);
  return id === undefined ? {} : { call: { id, launches: launchOf(name, callInput(block)), waits: name !== "SubagentHandback" } };
};

// What a client tool's result states: the call it answers, and the agent its texts name. One with no id states none.
const textBlock = object<Text>({ type: value(kinds.among(["text"])), ...textFields });
const textsOf = (sent: Content | undefined): string[] =>
  typeof sent === "string"
    ? [sent]
    : (sent ?? []).flatMap((block) => {
        const read = readShown(textBlock, block);
        return read.is === "read" ? [read.read.value.text] : [];
      });
const answers = fact(toolResultFields, ["tool_use_id"], ({ tool_use_id }) => tool_use_id);
const answerContent = fact(toolResultFields, ["content"], ({ content }) => content);
const answered = (block: unknown): Stated => {
  const id = answers(block);
  return id === undefined ? {} : { result: { answers: id, names: namedIn(textsOf(answerContent(block))) } };
};

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summaryOf = fact(textFields, ["text"], ({ text }) => summaryEnding.exec(text)?.[1]!.trim());
const summarized = (block: unknown, role: Role): Stated => {
  const summary = role === "assistant" ? summaryOf(block) : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent.
const isError = fact(toolResultFields, ["is_error"], ({ is_error }) => is_error === true);
const toolResult: Entry<ToolResult<string>> = {
  fields: toolResultFields,
  category: tools,
  stated: answered,
  failed: (block) => isError(block) === true,
  parts: ({ tool_use_id, content, is_error }, role) => {
    const id: Field[] = [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])];
    return [...(content === undefined ? [] : contentParts(content, role)), { id: "tool_use_id", kind: "fields", fields: id }];
  },
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverFailed = fact(serverToolResultFields, ["content"], ({ content }) => !Array.isArray(content) && content.type.endsWith("_error"));
const serverToolResult: Entry<ServerToolResult<string>> = {
  fields: serverToolResultFields,
  category: tools,
  failed: (block) => serverFailed(block) === true,
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
type Entries = { [T in Type]: Entry<BlockOf<T>> };
const entries: Entries = {
  text: {
    fields: textFields,
    category: byRole,
    parts: ({ text, citations }, _, form) => [textPart(text, form), ...(citations === undefined ? [] : [{ id: "citations", label: "citations", kind: "json", value: citations } as const])],
    text: ({ text }) => text,
    grows: ({ text, citations }) => ({ by: "text", text, citations }),
    stated: summarized,
  },
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  thinking: {
    fields: thinkingFields,
    category: (_, block) => (thought(block) === true ? "thinking" : "usage"),
    parts: ({ thinking, signature }) => [
      { id: "thinking", kind: "text", form: "markdown", text: thinking },
      { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
    ],
    grows: ({ thinking, signature }) => ({ by: "thinking", thinking, signature }),
  },
  redacted_thinking: { fields: { data: string }, category: usage, parts: ({ data }) => [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] },
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

// [LAW:single-enforcer] The one dispatch of a content block by its type, which every read of a block goes through:
// what `typed` makes of a block of a type with an entry, by that entry and its declaration's read of the block's other
// fields; `untyped`, of one of a type with no entry, named; and `unread`, of one whose type does not read, with why.
type Dispatch<R> = {
  typed: <T extends Type>(entry: Entry<BlockOf<T>>, read: Attempt<Fields<BlockOf<T>>>, type: T) => R;
  untyped: (type: string) => R;
  unread: (why: string) => R;
};
const typeAndFields = tagOf("type");
function dispatched<R>(block: unknown, to: Dispatch<R>): R {
  const named = readShown(typeAndFields, block);
  if (named.is === "refused") return to.unread(named.why);
  const { tag: type, fields } = named.read.value;
  return types.fits(type) ? typedBy(type, fields, to) : to.untyped(type);
}
// [LAW:types-are-the-program] The entry of the type `type`, so its declaration reads the fields its parts take.
function typedBy<T extends Type, R>(type: T, fields: Record<string, unknown>, to: Dispatch<R>): R {
  const entry: Entry<BlockOf<T>> = entries[type];
  return to.typed<T>(entry, readShown(object(entry.fields), fields), type);
}

// What a block's deltas grow while its stream sends it, by its type's entry: nothing for a type that streams nothing, or
// a start that does not read, which its stop shows raw.
export const growsOf = (start: unknown): Grows =>
  dispatched<Grows>(start, {
    typed: (entry, read) => (read.is === "read" && entry.grows !== undefined ? entry.grows(read.read.value) : { by: "nothing" }),
    untyped: () => ({ by: "nothing" }),
    unread: () => ({ by: "nothing" }),
  });

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`, and the text
// its pieces are split from, for a text block that reads. [LAW:no-silent-failure] A type with no entry is shown as its
// raw JSON under its type name; a block its declaration refuses is shown the same way, with why, and still states what
// its own fields say.
type Formatted = { block: Block; text: string | undefined };
export const formatBlock = (block: unknown, role: Role, form: Form): Block => blockOf(block, role, form, whole).block;
function blockOf(block: unknown, role: Role, form: Form, soFar: SoFar): Formatted {
  const json: Received = { kind: "json", value: block };
  return dispatched<Formatted>(block, {
    typed: (entry, read, type) => {
      const shown: Pick<Block, "name" | "parts"> & { text: string | undefined } =
        read.is === "refused"
          ? { name: type, parts: receivedParts(read.why, json), text: undefined }
          : {
              name: entry.name?.(read.read.value, type) ?? type,
              parts: [...entry.parts(read.read.value, role, form, soFar), ...unreadParts(read.read.unread)],
              text: entry.text?.(read.read.value),
            };
      const stating: Block = { category: entry.category(role, block), name: shown.name, parts: shown.parts, ...entry.stated?.(block, role) };
      // A tool's result that says its tool failed is named for it.
      return { block: entry.failed?.(block) === true ? { ...stating, name: `${stating.name}: error`, failed: true } : stating, text: shown.text };
    },
    untyped: (type) => ({ block: { category: byRole(role), name: type, parts: [{ id: "block", ...json }] }, text: undefined }),
    unread: (why) => ({ block: { category: byRole(role), name: "block", parts: receivedParts(why, json) }, text: undefined }),
  });
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export const formatContent = (block: unknown, role: Role): Block[] => contentOf(blockOf(block, role, "markdown", whole), role);
// A block of a reply still arriving, as far as it has come: its tool input, where it has one, the JSON text sent so far.
export const formatArriving = (arriving: Arriving): Block[] =>
  contentOf(blockOf(sentSoFar(arriving), "assistant", "markdown", arriving.grows.by === "input" ? { is: "arriving", input: arriving.grows.input } : whole), "assistant");
// A block a reply's stream stopped that is not one, raw with why, stating what its own fields say.
export const formatRefused = (block: unknown, why: string): Block[] => {
  const { block: formatted } = blockOf(block, "assistant", "markdown", whole);
  return [{ ...formatted, parts: receivedParts(why, { kind: "json", value: block }) }];
};
function contentOf({ block: formatted, text }: Formatted, role: Role): Block[] {
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

// The content of a tool result, a document or a search result, as parts: a text, or the parts of its blocks, each named
// under its block's index in the list, which only grows at its end. Its text is what the tool or the source returned,
// read verbatim.
function contentParts(content: Content, role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}

// An image's or a document's source as parts: media the view shows, the text a text document holds, the blocks of a
// content document, or a source of a type not here by its type, its other fields among its block's unread fields.
function sourceParts(source: SourceRead | UnknownSource, of: Medium, role: Role): Part[] {
  switch (source.type) {
    case "base64":
    case "url":
    case "file":
      return [{ id: "source", kind: "media", of, source }];
    case "text":
      return [{ id: "source", kind: "text", form: "verbatim", text: source.data }];
    case "content":
      return contentParts(source.content, role);
    case "unknown":
      return [{ id: "source", label: "source", kind: "fields", fields: [["type", source.named]] }];
  }
}
