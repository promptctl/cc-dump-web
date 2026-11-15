import type { Header } from "@cc-dump/proxy/format";
import { split, type Piece } from "./injected.ts";

// The blocks the view shows, and the formatter of the Messages API's content blocks into them.

// [LAW:one-source-of-truth] The kinds of content a block belongs to (docs/design/01-mvp.md, "Vocabulary"), in the order
// the filter bar lists them.
export const categories = ["user", "assistant", "tools", "system", "metadata", "thinking"] as const;
export type Category = (typeof categories)[number];

// What a media source is the source of: an image the view shows as one, or a document it names.
export type Medium = "image" | "document";
export type Source = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } | { type: "file"; file_id: string };

// [LAW:locality-or-seam] What a block shows, in kinds the view renders without knowing the API: a new block type, or a
// richer rendering of one, is a change to the formatter alone.
export type Part =
  | { kind: "text"; label?: string; text: string }
  | { kind: "json"; label?: string; value: unknown }
  | { kind: "fields"; label?: string; fields: Header[] }
  | { kind: "media"; label?: string; of: Medium; source: Source };

// [LAW:types-are-the-program] `injected`: the harness's own content in a message the user or the assistant sent, a system
// reminder, hook output or a CLAUDE.md, which the view never mistakes for what they said, whatever its category.
export type Block = { category: Category; name: string; parts: Part[]; injected?: true };

// What a source of at most one block gives: none, or the one, ready to spread among a group's blocks.
export type BlockOrNone = [] | [Block];

// The roles a message speaks in. Claude Code sends system-role messages among the user's and the assistant's.
export type Role = "user" | "assistant" | "system";
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };
// The pieces a message's text is, by its role: what its sender said, or the harness's, as the system role's is, split
// where the harness injected its own; an assistant's text whole, since the harness injects into the turns it sends
// (docs/design/01-mvp.md, F3), so a reply that quotes a reminder is one block as sent and as resent.
const pieces: Record<Role, (text: string) => Piece[]> = {
  user: (text) => split(text, "said"),
  assistant: (text) => [{ kind: "said", text }],
  system: (text) => split(text, "harness"),
};

// The label of the part holding a block's fields no read asked for. [LAW:one-source-of-truth] The history reads a
// reply's by it (view/history.ts).
export const unreadLabel = "fields";

// A JSON value that is not the shape its reader needs.
export class Misfit extends Error {}

// `format()`, or, when what it reads does not fit, `misfit` with why. [LAW:no-silent-failure] The callers show a value
// that does not fit as raw, with the reason, so a shape the API changes is seen, not dropped.
export function fitting<T>(format: () => T, misfit: (reason: string) => T): T {
  try {
    return format();
  } catch (error) {
    if (!(error instanceof Misfit)) throw error;
    return misfit(error.message);
  }
}

// A value shown as it was received, its JSON or its text, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, received: Part): Block {
  return { category, name, parts: [{ kind: "text", label: "does not fit", text: reason }, received] };
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Misfit(`${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// An error the API returned, as the body of an HTTP error or an event of a stream: it stands where the reply would have.
export function formatError(fields: Fields): Block {
  return { category: "assistant", name: "error", parts: [{ kind: "json", value: fields.value("error") }, ...restParts(fields, unreadLabel)] };
}

// [LAW:parse-dont-validate] The fields of a JSON object, each read as the type it must have or a Misfit naming it, and
// the fields no read asked for: those are shown as they are, so a field the API adds is never dropped.
export function readObject(value: unknown, what: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Misfit(`${what} is not an object`);
  const object = value as Record<string, unknown>;
  const read = new Set<string>();
  const field = (name: string) => {
    read.add(name);
    return object[name];
  };
  const fits = <T>(name: string, is: (value: unknown) => value is T, expected: string): T => {
    const value = field(name);
    if (!is(value)) throw new Misfit(`${what}'s ${name} is not ${expected}`);
    return value;
  };
  return {
    value: field,
    string: (name: string) => fits(name, (value) => typeof value === "string", "a string"),
    optionalString: (name: string) => fits(name, (value) => value === undefined || typeof value === "string", "a string, if present"),
    array: (name: string) => fits(name, Array.isArray, "a list"),
    rest: (): Record<string, unknown> => Object.fromEntries(Object.entries(object).filter(([name]) => !read.has(name))),
  };
}
export type Fields = ReturnType<typeof readObject>;

// The fields of an object no read asked for, as a part, when there are any.
export function restParts(fields: Fields, label: string): Part[] {
  const rest = fields.rest();
  return Object.keys(rest).length === 0 ? [] : [{ kind: "json", label, value: rest }];
}

// The fields of an object no read asked for, as a metadata block of their own, when there are any.
export function restBlock(fields: Fields, name: string): BlockOrNone {
  const parts = restParts(fields, unreadLabel);
  return parts.length === 0 ? [] : [{ category: "metadata", name, parts }];
}

// How one content block type is shown. `category` from the role of the message holding it; `name` and `parts` from
// its fields. Each reads the fields it shows; the ones it does not read are shown after its parts.
type Entry = { category: (role: Role) => Category; name?: (fields: Fields) => string; parts: (fields: Fields, role: Role) => Part[] };

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const thinking = () => "thinking" as const;

const toolUse: Entry = {
  category: tools,
  name: (fields) => `${fields.string("type")}: ${fields.string("name")}`,
  parts: (fields) => [{ kind: "fields", fields: [["id", fields.string("id")]] }, inputPart(fields.value("input"))],
};
// A tool's input: the API sends an object, so a string is the JSON a stream has sent so far, not yet JSON, shown as
// the text it is.
function inputPart(input: unknown): Part {
  return typeof input === "string" ? { kind: "text", label: "input so far", text: input } : { kind: "json", label: "input", value: input };
}
// A tool result's content is optional: a result may say only that its tool failed.
const toolResult: Entry = {
  category: tools,
  parts: (fields, role) => {
    const content = fields.value("content");
    return [{ kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] }, ...(content === undefined ? [] : contentParts(content, role))];
  },
};
const serverToolResult: Entry = {
  category: tools,
  parts: (fields) => [
    { kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] },
    { kind: "json", label: "content", value: fields.value("content") },
  ],
};
const ofSource = (of: Medium): Entry => ({ category: byRole, parts: (fields, role) => sourceParts(fields.value("source"), of, role) });

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries = new Map<string, Entry>([
  ["text", { category: byRole, parts: (fields) => [{ kind: "text", text: fields.string("text") }] }],
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
          { kind: "text", text },
          { kind: "fields", fields: [["signature", signature === undefined ? "none" : `${signature.length} characters`]] },
        ];
      },
    },
  ],
  ["redacted_thinking", { category: thinking, parts: (fields) => [{ kind: "fields", fields: [["data", `${fields.string("data").length} characters`]] }] }],
  ["tool_use", toolUse],
  ["server_tool_use", toolUse],
  ["mcp_tool_use", toolUse],
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

// A content block of a message in `role`, as the block the view shows. [LAW:no-silent-failure] A type with no entry
// is shown as its raw JSON under its type name; a block its entry cannot read is shown the same way, with why.
export function formatBlock(block: unknown, role: Role): Block {
  const type = typeof block === "object" && block !== null && "type" in block && typeof block.type === "string" ? block.type : "block";
  const entry = entries.get(type);
  if (entry === undefined) return { category: byRole(role), name: type, parts: [{ kind: "json", value: block }] };
  return fitting(
    () => {
      const fields = readObject(block, type);
      fields.value("type");
      const parts = entry.parts(fields, role);
      return { category: entry.category(role), name: entry.name?.(fields) ?? type, parts: [...parts, ...restParts(fields, unreadLabel)] };
    },
    (reason) => raw(entry.category(role), type, reason, { kind: "json", value: block }),
  );
}

// A content block of a message in `role`, as the blocks the view shows: the one block `formatBlock` makes, but for a text
// block, which is a block for each piece of its text, each named for what it is, so what the harness injected is never
// shown as what was said (docs/design/01-mvp.md, F3). A text block's other fields follow its last piece.
export function formatContent(block: unknown, role: Role): Block[] {
  const formatted = formatBlock(block, role);
  if (!isText(block)) return [formatted];
  const [, ...fields] = formatted.parts;
  const textPieces = pieces[role](block.text);
  return textPieces.map((piece, index) => {
    const parts: Part[] = [{ kind: "text", text: piece.text }, ...(index === textPieces.length - 1 ? fields : [])];
    return pieceBlock(piece, formatted.category, formatted.name, parts);
  });
}

function isText(block: unknown): block is { type: "text"; text: string } {
  return typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string";
}

// A piece as a block: what was said is named as the text block it is, and what was injected for what it is.
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

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows.
function contentParts(content: unknown, role: Role): Part[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (Array.isArray(content)) return content.flatMap((block) => formatBlock(block, role).parts);
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
        return [{ kind: "text", text: fields.string("data") }];
      case "content":
        return contentParts(fields.value("content"), role);
      // A source of a type not here: its other fields follow.
      default:
        return [{ kind: "fields", label: "source", fields: [["type", type]] }];
    }
  })();
  return [...parts, ...restParts(fields, "source fields")];
}
