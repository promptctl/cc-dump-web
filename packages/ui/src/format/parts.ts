import { fieldOf } from "@cc-dump/log/json";

// What a media source is the source of: an image the view shows as one, or a document it names.
export type Medium = "image" | "document";
export type Source = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } | { type: "file"; file_id: string };

// How a text reads (docs/design/02-design.md, "Two voices"): as Markdown, the way the model writes and reads what a
// sender wrote, or verbatim, the way a tool returned it or the proxy reports it. [LAW:one-type-per-behavior] One kind of
// text part, one rendering; the form is a value.
export type Form = "markdown" | "verbatim";

// [LAW:locality-or-seam] What a block shows, in kinds the view renders without knowing the API: a new block type, or a
// richer rendering of one, is a change to the formatter alone.
export type Part =
  | { kind: "text"; form: Form; label?: string; text: string }
  | { kind: "json"; label?: string; value: unknown }
  | { kind: "fields"; label?: string; fields: Field[] }
  | { kind: "media"; label?: string; of: Medium; source: Source }
  // A change of one text into another, shown line by line: what it removed and what it added, among the lines it kept
  // (format/diff.ts).
  | { kind: "diff"; label?: string; before: string; after: string };

// A field: a name and its value, a text, or the fields it holds, shown under it. A header is one, its value a text.
export type Field = [name: string, value: string | Field[]];

// A field as the line it shows: its name at its depth among the fields holding it, and its value, none for a field that
// holds fields, whose lines follow it a depth deeper.
export type FieldLine = { name: string; value: string | undefined; depth: number };
export function fieldLines(fields: Field[], depth = 0): FieldLine[] {
  return fields.flatMap(([name, value]) =>
    typeof value === "string" ? [{ name, value, depth }] : [{ name, value: undefined, depth }, ...fieldLines(value, depth + 1)],
  );
}

// What a field shows a value as: an object or a list with members, or a string that is the JSON of one to the byte, as
// metadata.user_id is, as its members' fields, a list's named by index; any other value as its JSON, so a string reads
// quoted and no value reads as one of another type.
export function fieldValue(value: unknown): string | Field[] {
  const held = typeof value === "string" ? heldJson(value) : value;
  return typeof held === "object" && held !== null && Object.keys(held).length > 0
    ? Object.entries(held).map(([name, member]): Field => [name, fieldValue(member)])
    : (JSON.stringify(value) ?? "undefined");
}

// The value a string is the JSON of, when showing that value shows every byte of the string; otherwise the string. Only
// an object's or a list's JSON shows as fields, and it begins with its bracket, so no other string is parsed.
function heldJson(text: string): unknown {
  if (!/^[[{]/.test(text)) return text;
  try {
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? value : text;
  } catch {
    return text;
  }
}

// A value as the part showing it: its fields when it holds any, else the JSON text a field would show it as.
export function valuePart(value: unknown): Part {
  const shown = fieldValue(value);
  return typeof shown === "string" ? { kind: "text", form: "verbatim", text: shown } : { kind: "fields", fields: shown };
}

// The fields of `value` at each of `paths`, a path its field names joined by dots, named by it, those it holds, as a part:
// what a block's line previews of a value that holds more than a line would.
export function pickedPart(value: unknown, paths: string[]): Extract<Part, { kind: "fields" }> {
  const held = paths.map((path): [string, unknown] => [path, path.split(".").reduce(fieldOf, value)]);
  return { kind: "fields", fields: held.filter(([, member]) => member !== undefined).map(([path, member]) => [path, fieldValue(member)]) };
}

// An object's fields as a part, when it has any.
export function fieldsParts(object: Record<string, unknown>, labelled: { label?: string } = {}): Extract<Part, { kind: "fields" }>[] {
  const fields = Object.entries(object).map(([name, value]): Field => [name, fieldValue(value)]);
  return fields.length === 0 ? [] : [{ kind: "fields", ...labelled, fields }];
}

// Why a value is not shown as what it was read as, set before the value as it was received.
export const doesNotFit = (reason: string): Part => ({ kind: "text", form: "verbatim", label: "does not fit", text: reason });
