import { split, type Piece } from "./injected.ts";
import { restParts, fieldValue, receivedParts, type Field, type Form, type Medium, type Part, type PartBody, type Received, type Source } from "./parts.ts";
import { attempt, kinds, nullable, object, optional, parse, raw as asIs, strip, tagged, value, type Kept, type Reader, type Readers } from "@cc-dump/log/json";
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
// [LAW:no-silent-failure] What the formatter cannot read, a body, a message, a block or a tool definition, is shown this
// way, never thrown or left out, so traffic of a shape this view does not know is seen.
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

// How one content block type is shown: `home`, the category of a block of its type, by the role of the message holding
// it; `show`, the block it is shown as, from its fields but its type (`reading`), or refused.
type Entry = { home: (role: Role) => Category; show: (fields: Record<string, unknown>, type: string, role: Role, form: Form) => Block };

// What an entry shows of a block: its name, where it is not the block's type; its parts; what it states that a thread
// stands after (Stated); its category, where it is not its type's home; and whether it says its tool failed. `form`:
// how a text block's text reads where the block is: Markdown in a message, verbatim in what a tool or a document
// returned.
type Shown = { name?: string; parts: Part[]; category?: Category; failed?: boolean } & Stated;

// [LAW:one-source-of-truth] The entry of a block whose fields `readers` read, each as the type it must have, or refused
// naming the type: all it shows and states is read off that one read, then the fields it does not read, so a field the
// API adds is shown. A block it refuses states nothing.
function reading<T extends object>(home: (role: Role) => Category, readers: Readers<T>, show: (fields: T & { type: string }, role: Role, form: Form) => Shown): Entry {
  const read = object(readers);
  return {
    home,
    show: (block, type, role, form) => {
      const { fields, rest } = parse(read, block, type);
      const { name = type, parts, category = home(role), failed, ...stated } = show({ ...fields, type }, role, form);
      // A tool's result that says its tool failed is named for it.
      const shown: Block = { category, name: failed ? `${name}: error` : name, parts: [...parts, ...unreadParts(rest)], ...stated };
      return failed ? { ...shown, failed: true } : shown;
    },
  };
}

// [LAW:one-source-of-truth] A fact read off a value the view shows whole: what `reader` reads of it, or `none` where it
// does not read, since the value beside it shows what it holds.
export const factOf = <T, N>(reader: Reader<T>, json: unknown, none: N): T | N =>
  attempt(
    () => reader(json, []).value,
    () => none,
  );

const text = value(kinds.string);
const optionalText = optional(text);
// What a message, the system prompt or a tool's result says: a string, which is the text of one text block, or a list
// of blocks.
export const said = value({ fits: (json): json is string | unknown[] => typeof json === "string" || Array.isArray(json), expected: "a string or a list of blocks" });

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const usage = () => "usage" as const;

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON. `states`, what its call states.
type Use = { id: string; name: string; input: unknown };
const toolUse = (read: (name: string, input: unknown) => Part[], states: (use: Use) => Stated = () => ({})): Entry =>
  reading(tools, { name: text, id: text, input: optional(asIs) }, ({ type, name, id, input }) => ({
    name: `${type}: ${name}`,
    // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is:
    // the input's deltas' `partial_json`, joined, another text than the input it becomes.
    parts: [
      ...(typeof input === "string" ? [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input } as const] : read(name, input)),
      { id: "id", kind: "fields", fields: [["id", id]] },
    ],
    ...states({ id, name, input }),
  }));
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends.
const agentInput = strip(object({ subagent_type: optionalText }));
const skillInput = strip(object({ skill: text }));
const launchOf = (name: string, input: unknown): Launch | undefined => {
  if (name === "Agent") return { tool: "Agent", type: factOf(agentInput, input, undefined)?.subagent_type };
  const skill = name === "Skill" ? factOf(skillInput, input, undefined)?.skill : undefined;
  return skill === undefined ? undefined : { tool: "Skill", skill };
};
const called = ({ id, name, input }: Use): Stated => ({ call: { id, launches: launchOf(name, input), waits: name !== "SubagentHandback" } });

// The texts of a tool result's content, which name the agent it answers for (format/wire.ts).
const resultText = strip(object({ text }));
const textsOf = (content: string | unknown[]): string[] => (typeof content === "string" ? [content] : content.flatMap((block) => factOf(resultText, block, undefined)?.text ?? []));

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (text: string, role: Role): Stated => {
  const summary = role === "assistant" ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A client tool's result: the call it answers, and the agent its texts name. Its content is optional: a result may say
// only that its tool failed. A call's or a result's id follows what it holds: it is how the two refer to each other,
// not what either says. Its tool failed as its is_error says, which follows the id where it was sent.
const toolResult = reading(tools, { content: optional(said), is_error: optional(asIs), tool_use_id: text }, ({ content, is_error, tool_use_id }, role) => {
  const id: Field[] = [["tool_use_id", tool_use_id], ...(is_error === undefined ? [] : [["is_error", fieldValue(is_error)] satisfies Field])];
  return {
    parts: [...(content === undefined ? [] : contentParts(content, role)), { id: "tool_use_id", kind: "fields", fields: id }],
    failed: is_error === true,
    result: { answers: tool_use_id, names: namedIn(content === undefined ? [] : textsOf(content)) },
  };
});
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const typedContent = strip(object({ type: text }));
const serverToolResult = reading(tools, { content: optional(asIs), tool_use_id: text }, ({ content, tool_use_id }) => ({
  parts: [
    { id: "content", label: "content", kind: "json", value: content },
    { id: "tool_use_id", kind: "fields", fields: [["tool_use_id", tool_use_id]] },
  ],
  failed: factOf(typedContent, content, undefined)?.type.endsWith("_error") ?? false,
}));

// An image's or a document's source, by its type: media the view shows, the text a text document holds, or the blocks
// of a content document.
type Sourced = Source | { type: "text"; data: string } | { type: "content"; content: string | unknown[] };
const sourced = tagged<"type", Sourced>("type", { base64: { media_type: text, data: text }, url: { url: text }, file: { file_id: text }, text: { data: text }, content: { content: said } });
function sourceParts(source: Sourced, of: Medium, role: Role): Part[] {
  switch (source.type) {
    case "text":
      return [{ id: "source", kind: "text", form: "verbatim", text: source.data }];
    case "content":
      return contentParts(source.content, role);
    default:
      return [{ id: "source", kind: "media", of, source }];
  }
}
const ofSource = (of: Medium): Entry =>
  reading(byRole, { source: sourced }, ({ source: { fields, rest } }, role) => ({ parts: [...sourceParts(fields, of, role), ...restParts(rest, { id: "source/unread", label: "source fields" })] }));

// [LAW:one-source-of-truth] A text block's text as a part, the one name it has wherever it is made: in the text's block,
// and in each piece of it and that piece's preview (`formatContent`).
const textId = "text";
const textPart = (text: string, form: Form): Part => ({ id: textId, kind: "text", form, text });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", reading(byRole, { text }, ({ text }, role, form) => ({ parts: [textPart(text, form)], ...summarized(text, role) }))],
  // [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
  // in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
  // reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
  // shows the usage, and is never dropped (docs/design/01-features.md, F3). A streamed thinking block has no signature
  // until its signature delta, just before its stop.
  [
    "thinking",
    reading(
      () => "thinking",
      { thinking: text, signature: optionalText },
      ({ thinking, signature }) => ({
        category: thinking === "" ? "usage" : "thinking",
        parts: [
          { id: "thinking", kind: "text", form: "markdown", text: thinking },
          { id: "signature", kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
        ],
      }),
    ),
  ],
  ["redacted_thinking", reading(usage, { data: text }, ({ data }) => ({ parts: [{ id: "data", kind: "fields", fields: [["data", `${data.length} characters`]] }] }))],
  // The summary the API made of the conversation before it, which a later request sends in its place, null while a
  // stream has sent none of it; its opaque state is among its other fields.
  ["compaction", reading(byRole, { content: nullable(text) }, ({ content }) => ({ parts: content === null ? [] : [{ id: "content", kind: "text", form: "markdown", text: content }] }))],
  ["tool_use", toolUse(inputParts, called)],
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
  ["container_upload", reading(tools, {}, () => ({ parts: [] }))],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    reading(byRole, { source: text, title: text, content: said }, ({ source, title, content }, role) => ({
      parts: [{ id: "search result", kind: "fields", fields: [["source", source], ["title", title]] }, ...contentParts(content, role)],
    })),
  ],
]);

const typed = object({ type: text });

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block with no type, or
// one its entry cannot read, is shown the same way, with why.
export function formatBlock(block: unknown, role: Role, form: Form): Block {
  return attempt(
    () => {
      const { fields: { type }, rest } = parse(typed, block, "block");
      const entry = entries.get(type);
      if (entry === undefined) return { category: byRole(role), name: type, parts: [{ id: "block", kind: "json", value: block }] };
      return attempt(
        () => entry.show(rest, type, role, form),
        (reason) => raw(entry.home(role), type, reason, { kind: "json", value: block }),
      );
    },
    (reason) => raw(byRole(role), "block", reason, { kind: "json", value: block }),
  );
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-features.md, F3). A text block's other fields follow its last piece, which states
// what the text ends with.
export function formatContent(block: unknown, role: Role): Block[] {
  const formatted = formatBlock(block, role, "markdown");
  const said = formatted.parts.find((part) => part.id === textId);
  if (said?.kind !== "text") return [formatted];
  const fields = formatted.parts.filter((part) => part !== said);
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](said.text);
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

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows, each
// named under its block's index in the list, which only grows at its end. Its text is what the tool or the source
// returned, read verbatim.
function contentParts(content: string | unknown[], role: Role): Part[] {
  if (typeof content === "string") return [{ id: "content", kind: "text", form: "verbatim", text: content }];
  return content.flatMap((block, index) => formatBlock(block, role, "verbatim").parts.map((part) => ({ ...part, id: `${index}/${part.id}` })));
}
