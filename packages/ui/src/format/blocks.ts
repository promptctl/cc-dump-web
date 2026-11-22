import { split, type Piece } from "./injected.ts";
import { doesNotFit, fieldsParts, fieldValue, type Field, type Form, type Medium, type Part } from "./parts.ts";
import { fitting, Misfit, readObject, type Fields } from "./read.ts";
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
export type Block = { category: Category; name: string; parts: Part[]; injected?: true; preview?: Part[]; failed?: true } & Stated;
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

// The label of the part holding a block's fields no read asked for. [LAW:one-source-of-truth] The history reads a
// reply's by it (view/history.ts).
export const unreadLabel = "fields";

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Part): Block {
  return { category, name, parts: [doesNotFit(reason), received] };
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
export function formatError(fields: Fields): Block {
  return { category: "assistant", name: "error", parts: [{ kind: "json", value: fields.value("error") }, ...unreadParts(fields)] };
}


// The fields of an object no read asked for, as a part, when there are any.
export const unreadParts = (fields: Fields) => fieldsParts(fields.rest(), { label: unreadLabel });

// The fields of an object no read asked for, as a block of their own in `category`, when there are any.
export function restBlock(fields: Fields, category: Category, name: string): BlockOrNone {
  const parts = unreadParts(fields);
  return parts.length === 0 ? [] : [{ category, name, parts }];
}

// How one content block type is shown. `category` from the role of the message holding it and the block as sent, so a
// block its entry cannot read has the same one; `name`, where it is not the block's type, and `parts` from its fields.
// Each reads the fields it shows; the ones it does not read are shown after its parts. `form`: how a text block's text
// reads where the block is: Markdown in a message, verbatim in what a tool or a document returned. `failed`: whether a
// tool's result says its tool failed, read off the block as sent, so one its entry cannot read says so too. `stated`:
// what the block states that a thread stands after (Stated), read off the block as sent too.
type Entry = {
  category: (role: Role, block: unknown) => Category;
  name?: (fields: Fields, role: Role) => string;
  parts: (fields: Fields, role: Role, form: Form) => Part[];
  failed?: (block: unknown) => boolean;
  stated?: (block: unknown, role: Role) => Stated;
};

// A field of what was sent, if it is an object that has it.
const sentField = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined);

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
// [LAW:types-are-the-program] Thinking is what was thought, its text. A thinking block that holds none, as every one
// in Claude Code's traffic of 2026-11-16 does, and as a redacted one does, says only what the API reported about its
// reply, how long its signature or its data is: it is `usage`, so it is no row among what was said until the reader
// shows the usage, and is never dropped (docs/design/01-features.md, F3).
const thought = (_: Role, block: unknown): Category => {
  const text = sentField(block, "thinking");
  return typeof text === "string" && text !== "" ? "thinking" : "usage";
};

// A tool use, its input read by `read`: a client tool's by the tool's own shape (format/tools.ts), a server tool's or
// an MCP server's, whose names are their own and may be any, as its JSON.
const toolUse = (read: (name: string, input: unknown) => Part[]): Entry => ({
  category: tools,
  name: (fields) => `${fields.string("type")}: ${fields.string("name")}`,
  parts: (fields) => {
    const input = fields.value("input");
    // The API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as the text it is.
    const parts: Part[] = typeof input === "string" ? [{ kind: "text", form: "verbatim", label: "input so far", text: input }] : read(fields.string("name"), input);
    return [...parts, { kind: "fields", fields: [["id", fields.string("id")]] }];
  },
});
// What a client tool's call states, by the tool, as seen on Claude Code's traffic, 2026-11-17. Its Agent tool launches
// a subagent: it sends its input's `prompt` as the subagent's first message, to the agent its `subagent_type` names.
// Its Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet, while
// an Agent call launches an agent whatever its input holds, of the type it names once it is read. A subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends. A call with no id is shown as not fitting (`toolUse`), and states none.
const launchOf = (name: unknown, input: unknown): Launch | undefined => {
  const type = sentField(input, "subagent_type");
  const skill = sentField(input, "skill");
  if (name === "Agent") return { tool: "Agent", type: typeof type === "string" ? type : undefined };
  return name === "Skill" && typeof skill === "string" ? { tool: "Skill", skill } : undefined;
};
const called = (block: unknown): Stated => {
  const id = sentField(block, "id");
  const name = sentField(block, "name");
  return typeof id === "string" ? { call: { id, launches: launchOf(name, sentField(block, "input")), waits: name !== "SubagentHandback" } } : {};
};

// What a client tool's result states: the call it answers, and the agent its texts name. One with no id is shown as not
// fitting (`toolResult`), and states none.
const answered = (block: unknown): Stated => {
  const id = sentField(block, "tool_use_id");
  const content = sentField(block, "content");
  const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.flatMap((one) => (typeof sentField(one, "text") === "string" ? [sentField(one, "text") as string] : [])) : [];
  return typeof id === "string" ? { result: { answers: id, names: namedIn(texts) } } : {};
};

// The summary an assistant's text ends with: what stands between a `<summary>` that begins a line and the
// `</summary>` that ends the text, as Claude Code's compaction asks for it (seen on its traffic, 2026-11-17), less the
// space around it, which the harness drops as it sends the summary on. A Markdown `<details>` holds its
// `<summary>` inside a line and ends after it, so it is none; nor is a summary of nothing.
const summaryEnding = /(?<![^\n])<summary>([\s\S]*)<\/summary>\s*$/;
const summarized = (block: unknown, role: Role): Stated => {
  const text = sentField(block, "text");
  const summary = role === "assistant" && typeof text === "string" ? summaryEnding.exec(text)?.[1]!.trim() : undefined;
  return summary === undefined || summary === "" ? {} : { summary };
};

// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. Its tool failed as its is_error says,
// which follows the id where it was sent.
const toolResult: Entry = {
  category: tools,
  stated: answered,
  failed: (block) => sentField(block, "is_error") === true,
  parts: (fields, role) => {
    const content = fields.value("content");
    const failed = fields.value("is_error");
    const id: Field[] = [["tool_use_id", fields.string("tool_use_id")], ...(failed === undefined ? [] : [["is_error", fieldValue(failed)] satisfies Field])];
    return [...(content === undefined ? [] : contentParts(content, role)), { kind: "fields", fields: id }];
  },
};
// A server tool's result says its tool failed by its content's type, the tool's error type (`web_search_tool_result_error`,
// `code_execution_tool_result_error`, ...), as the Messages API names each.
const serverToolResult: Entry = {
  category: tools,
  failed: (block) => String(sentField(sentField(block, "content"), "type")).endsWith("_error"),
  parts: (fields) => [
    { kind: "json", label: "content", value: fields.value("content") },
    { kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] },
  ],
};
const ofSource = (of: Medium): Entry => ({ category: byRole, parts: (fields, role) => sourceParts(fields.value("source"), of, role) });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, parts: (fields, _, form) => [{ kind: "text", form, text: fields.string("text") }], stated: summarized }],
  // A streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      category: thought,
      parts: (fields) => {
        const text = fields.string("thinking");
        const signature = fields.optionalString("signature");
        return [
          { kind: "text", form: "markdown", text },
          { kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
        ];
      },
    },
  ],
  ["redacted_thinking", { category: thought, parts: (fields) => [{ kind: "fields", fields: [["data", `${fields.string("data").length} characters`]] }] }],
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
  ["container_upload", { category: tools, parts: () => [] }],
  ["image", ofSource("image")],
  ["document", ofSource("document")],
  [
    "search_result",
    {
      category: byRole,
      parts: (fields, role) => [
        { kind: "fields", fields: [["source", fields.string("source")], ["title", fields.string("title")]] },
        ...contentParts(fields.value("content"), role),
      ],
    },
  ],
]);

// A content block of a message in `role`, as the block the view shows, a text block's text read in `form`.
// [LAW:no-silent-failure] A type with no entry is shown as its raw JSON under its type name; a block its entry cannot
// read is shown the same way, with why.
export function formatBlock(block: unknown, role: Role, form: Form): Block {
  const type = typeof block === "object" && block !== null && "type" in block && typeof block.type === "string" ? block.type : "block";
  const entry = entries.get(type);
  if (entry === undefined) return { category: byRole(role), name: type, parts: [{ kind: "json", value: block }] };
  const shown = fitting(
    (): Block => {
      const fields = readObject(block, type);
      fields.value("type");
      const parts = entry.parts(fields, role, form);
      return { category: entry.category(role, block), name: entry.name?.(fields, role) ?? type, parts: [...parts, ...unreadParts(fields)] };
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
  const [, ...fields] = formatted.parts;
  const stated: Stated = formatted.summary === undefined ? {} : { summary: formatted.summary };
  const textPieces = pieces[role](block.text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const last = index === textPieces.length - 1;
    const rest = last ? fields : [];
    const parts: Part[] = [{ kind: "text", form, text: piece.text }, ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, formatted.category, formatted.name, parts), preview: [{ kind: "text", form, text: piece.content }, ...rest], ...(last ? stated : {}) };
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

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows. Its
// text is what the tool or the source returned, read verbatim.
function contentParts(content: unknown, role: Role): Part[] {
  if (typeof content === "string") return [{ kind: "text", form: "verbatim", text: content }];
  if (Array.isArray(content)) return content.flatMap((block) => formatBlock(block, role, "verbatim").parts);
  throw new Misfit("content is neither a string nor a list of blocks");
}

// An image's or a document's source: media the view shows, the text a text document holds, or the blocks of a
// content document. A source of another type is shown as its JSON.
function sourceParts(source: unknown, of: Medium, role: Role): Part[] {
  const fields = readObject(source, "source");
  const type = fields.string("type");
  const parts = ((): Part[] => {
    switch (type) {
      case "base64":
        return [{ kind: "media", of, source: { type, media_type: fields.string("media_type"), data: fields.string("data") } }];
      case "url":
        return [{ kind: "media", of, source: { type, url: fields.string("url") } }];
      case "file":
        return [{ kind: "media", of, source: { type, file_id: fields.string("file_id") } }];
      case "text":
        return [{ kind: "text", form: "verbatim", text: fields.string("data") }];
      case "content":
        return contentParts(fields.value("content"), role);
      // A source of a type not here: its other fields follow.
      default:
        return [{ kind: "fields", label: "source", fields: [["type", type]] }];
    }
  })();
  return [...parts, ...fieldsParts(fields.rest(), { label: "source fields" })];
}
