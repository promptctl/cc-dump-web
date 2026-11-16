import { split, type Piece } from "./injected.ts";
import { doesNotFit, fieldsParts, fieldValue, type Field, type Form, type Medium, type Part } from "./parts.ts";
import { fitting, Misfit, readObject, type Fields } from "./read.ts";
import { inputParts, jsonInput } from "./tools.ts";

// The blocks the view shows, and the formatter of the Messages API's content blocks into them.

// [LAW:one-source-of-truth] The kinds of content a block belongs to (docs/design/01-mvp.md, "Vocabulary"), in the order
// the filter bar lists them.
export const categories = ["user", "assistant", "tools", "system", "metadata", "thinking"] as const;
export type Category = (typeof categories)[number];

// [LAW:types-are-the-program] `injected`: the harness's own content in a message the user or the assistant sent, a system
// reminder, hook output or a CLAUDE.md, which the view never mistakes for what they said, whatever its category.
// `preview`: the parts the block's collapsed line reads in place of its own (docs/design/02-design.md, "Print what
// varies"), for a block whose first part with content is not what tells it from its kind's others (view/rows.ts).
// `failed`: a tool's result that says its tool failed (its is_error), which the minimap marks in the theme's error.
export type Block = { category: Category; name: string; parts: Part[]; injected?: true; preview?: Part[]; failed?: true };

// What a source of at most one block gives: none, or the one, ready to spread among a group's blocks.
export type BlockOrNone = [] | [Block];

// The roles a message speaks in. Claude Code sends system-role messages among the user's and the assistant's.
export type Role = "user" | "assistant" | "system";
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };
// What a sender's own text is named: who said it.
const speakers: Record<Role, string> = { user: "user", assistant: "assistant", system: "system prompt" };
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-mvp.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
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

// The fields of an object no read asked for, as a metadata block of their own, when there are any.
export function restBlock(fields: Fields, name: string): BlockOrNone {
  const parts = unreadParts(fields);
  return parts.length === 0 ? [] : [{ category: "metadata", name, parts }];
}

// How one content block type is shown. `category` from the role of the message holding it; `name` and `parts` from
// its fields. Each reads the fields it shows; the ones it does not read are shown after its parts. `form`: how a text
// block's text reads where the block is: Markdown in a message, verbatim in what a tool or a document returned.
type Entry = {
  category: (role: Role) => Category;
  name?: (fields: Fields, role: Role) => string;
  parts: (fields: Fields, role: Role, form: Form) => Part[];
  failed?: (fields: Fields) => boolean;
};

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const thinking = () => "thinking" as const;

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
// A tool result's content is optional: a result may say only that its tool failed. A call's or a result's id follows
// what it holds: it is how the two refer to each other, not what either says. A result is named for whether its tool
// failed, as its is_error says, which follows the id where it was sent.
const toolFailed = (fields: Fields) => fields.value("is_error") === true;
const toolResult: Entry = {
  category: tools,
  name: (fields) => `${fields.string("type")}${toolFailed(fields) ? ": error" : ""}`,
  failed: toolFailed,
  parts: (fields, role) => {
    const content = fields.value("content");
    const failed = fields.value("is_error");
    const id: Field[] = [["tool_use_id", fields.string("tool_use_id")], ...(failed === undefined ? [] : [["is_error", fieldValue(failed)] satisfies Field])];
    return [...(content === undefined ? [] : contentParts(content, role)), { kind: "fields", fields: id }];
  },
};
const serverToolResult: Entry = {
  category: tools,
  parts: (fields) => [
    { kind: "json", label: "content", value: fields.value("content") },
    { kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] },
  ],
};
const ofSource = (of: Medium): Entry => ({ category: byRole, parts: (fields, role) => sourceParts(fields.value("source"), of, role) });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, name: (_, role) => speakers[role], parts: (fields, _, form) => [{ kind: "text", form, text: fields.string("text") }] }],
  // Claude Code asks for thinking with display omitted: the text is empty and the signature is the whole block. A
  // streamed thinking block has no signature until its signature delta, just before its stop.
  [
    "thinking",
    {
      category: thinking,
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
  ["redacted_thinking", { category: thinking, parts: (fields) => [{ kind: "fields", fields: [["data", `${fields.string("data").length} characters`]] }] }],
  ["tool_use", toolUse(inputParts)],
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
  return fitting(
    () => {
      const fields = readObject(block, type);
      fields.value("type");
      const parts = entry.parts(fields, role, form);
      const shown: Block = { category: entry.category(role), name: entry.name?.(fields, role) ?? type, parts: [...parts, ...unreadParts(fields)] };
      return entry.failed?.(fields) ? { ...shown, failed: true } : shown;
    },
    (reason) => raw(entry.category(role), type, reason, { kind: "json", value: block }),
  );
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-mvp.md, F3). A text block's other fields follow its last piece.
export function formatContent(block: unknown, role: Role): Block[] {
  const formatted = formatBlock(block, role, "markdown");
  if (!isText(block)) return [formatted];
  const [, ...fields] = formatted.parts;
  const textPieces = pieces[role](block.text);
  return textPieces.map((piece, index) => {
    const form = pieceForm[piece.kind];
    const rest = index === textPieces.length - 1 ? fields : [];
    const parts: Part[] = [{ kind: "text", form, text: piece.text }, ...rest];
    // Its line previews what it holds, not the tag or line that marks it as what its name says.
    return { ...pieceBlock(piece, formatted.category, formatted.name, parts), preview: [{ kind: "text", form, text: piece.content }, ...rest] };
  });
}

function isText(block: unknown): block is { type: "text"; text: string } {
  return typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
}

// How a piece's text reads (docs/design/02-design.md, "Two voices"): a hook's output is what a program printed,
// verbatim; every other piece is prose a sender or the harness wrote, Markdown.
const pieceForm: Record<Piece["kind"], Form> = { said: "markdown", reminder: "markdown", hook: "verbatim", claude_md: "markdown", section: "markdown" };

// A piece as a block: what was said is named as its text block is, for who said it, and what was injected for what it is.
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
