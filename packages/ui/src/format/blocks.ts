// The blocks the view shows, and the formatter of the Messages API's content blocks into them.

export type Category = "user" | "assistant" | "tools" | "system" | "metadata" | "thinking";

export type Source = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } | { type: "file"; file_id: string };

// [LAW:locality-or-seam] What a block shows, in kinds the view renders without knowing the API: a new block type, or a
// richer rendering of one, is a change to the formatter alone.
export type Part =
  | { kind: "text"; label?: string; text: string }
  | { kind: "json"; label?: string; value: unknown }
  | { kind: "fields"; label?: string; fields: Header[] }
  | { kind: "media"; label?: string; source: Source };
type Header = [name: string, value: string];

export type Block = { category: Category; name: string; parts: Part[] };

// The roles a message speaks in. Claude Code sends system-role messages among the user's and the assistant's.
export type Role = "user" | "assistant" | "system";
export const roleCategory: Record<Role, Category> = { user: "user", assistant: "assistant", system: "system" };

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

// A value shown as its raw JSON, with why it is not shown as what it was read as.
export function raw(category: Category, name: string, reason: string, value: unknown): Block {
  return { category, name, parts: [{ kind: "text", label: "does not fit", text: reason }, { kind: "json", value }] };
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
  return { category: "assistant", name: "error", parts: [{ kind: "json", value: fields.value("error") }, ...restParts(fields, "fields")] };
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

// How one content block type is shown. `category` from the role of the message holding it; `name` and `parts` from
// its fields. Each reads the fields it shows; the ones it does not read are shown after its parts.
type Entry = { category: (role: Role) => Category; name?: (fields: Fields) => string; parts: (fields: Fields, role: Role) => Part[] };

const byRole = (role: Role) => roleCategory[role];
const tools = () => "tools" as const;
const thinking = () => "thinking" as const;

const toolUse: Entry = {
  category: tools,
  name: (fields) => `${fields.string("type")}: ${fields.string("name")}`,
  parts: (fields) => [
    { kind: "fields", fields: [["id", fields.string("id")]] },
    { kind: "json", label: "input", value: fields.value("input") },
  ],
};
const serverToolResult: Entry = {
  category: tools,
  parts: (fields) => [
    { kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] },
    { kind: "json", label: "content", value: fields.value("content") },
  ],
};
const ofSource: Entry = { category: byRole, parts: (fields, role) => sourceParts(fields.value("source"), role) };

// [LAW:one-type-per-behavior] Every content block type the Messages API documents, one entry each. A type not here is
// shown as its raw JSON under its type name.
const entries: Partial<Record<string, Entry>> = {
  text: { category: byRole, parts: (fields) => [{ kind: "text", text: fields.string("text") }] },
  // Claude Code asks for thinking with display omitted: the text is empty and the signature is the whole block.
  thinking: {
    category: thinking,
    parts: (fields) => [
      { kind: "text", text: fields.string("thinking") },
      { kind: "fields", fields: [["signature", `${fields.string("signature").length} characters`]] },
    ],
  },
  redacted_thinking: { category: thinking, parts: (fields) => [{ kind: "fields", fields: [["data", `${fields.string("data").length} characters`]] }] },
  tool_use: toolUse,
  server_tool_use: toolUse,
  mcp_tool_use: toolUse,
  tool_result: {
    category: tools,
    parts: (fields, role) => [{ kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] }, ...contentParts(fields.value("content"), role)],
  },
  mcp_tool_result: {
    category: tools,
    parts: (fields, role) => [{ kind: "fields", fields: [["tool_use_id", fields.string("tool_use_id")]] }, ...contentParts(fields.value("content"), role)],
  },
  web_search_tool_result: serverToolResult,
  web_fetch_tool_result: serverToolResult,
  code_execution_tool_result: serverToolResult,
  bash_code_execution_tool_result: serverToolResult,
  text_editor_code_execution_tool_result: serverToolResult,
  tool_search_tool_result: serverToolResult,
  container_upload: { category: tools, parts: () => [] },
  image: ofSource,
  document: ofSource,
  search_result: {
    category: byRole,
    parts: (fields, role) => [
      { kind: "fields", fields: [["source", fields.string("source")], ["title", fields.string("title")]] },
      ...contentParts(fields.value("content"), role),
    ],
  },
};

// A content block of a message in `role`, as the block the view shows. [LAW:no-silent-failure] A type with no entry
// is shown as its raw JSON under its type name; a block its entry cannot read is shown the same way, with why.
export function formatBlock(block: unknown, role: Role): Block {
  const type = typeof block === "object" && block !== null && "type" in block && typeof block.type === "string" ? block.type : "block";
  const entry = entries[type];
  if (entry === undefined) return { category: byRole(role), name: type, parts: [{ kind: "json", value: block }] };
  return fitting(
    () => {
      const fields = readObject(block, type);
      fields.value("type");
      const parts = entry.parts(fields, role);
      return { category: entry.category(role), name: entry.name?.(fields) ?? type, parts: [...parts, ...restParts(fields, "fields")] };
    },
    (reason) => raw(entry.category(role), type, reason, block),
  );
}

// The content of a tool result, a document or a search result: a string, or content blocks, whose parts it shows.
function contentParts(content: unknown, role: Role): Part[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (Array.isArray(content)) return content.flatMap((block) => formatBlock(block, role).parts);
  throw new Misfit("content is neither a string nor a list of blocks");
}

// An image's or a document's source: media the view shows, the text a text document holds, or the blocks of a
// content document. A source of another type is shown as its JSON.
function sourceParts(source: unknown, role: Role): Part[] {
  const fields = readObject(source, "source");
  const type = fields.string("type");
  const parts = ((): Part[] => {
    switch (type) {
      case "base64":
        return [{ kind: "media", source: { type, media_type: fields.string("media_type"), data: fields.string("data") } }];
      case "url":
        return [{ kind: "media", source: { type, url: fields.string("url") } }];
      case "file":
        return [{ kind: "media", source: { type, file_id: fields.string("file_id") } }];
      case "text":
        return [{ kind: "text", text: fields.string("data") }];
      case "content":
        return contentParts(fields.value("content"), role);
      default:
        return [{ kind: "json", label: "source", value: source }];
    }
  })();
  return [...parts, ...restParts(fields, "source fields")];
}
