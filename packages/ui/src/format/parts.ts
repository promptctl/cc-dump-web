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
// [LAW:one-source-of-truth] `id`: the part's name among its block's parts, given where the formatter makes it from what
// it shows, as "command" or "id", and prefixed with the place of the content block it came from in a list of them
// (`within`). The view names a part's texts by it, so a step that adds a part ahead of another, or makes a block's
// parts again in another shape, leaves the reader's place on the text it was in. The block's key checks no two parts
// share one (format.ts, `keyed`).
export type Part = { id: string } & (
  | { kind: "text"; form: Form; label?: string; text: string }
  | { kind: "json"; label?: string; value: unknown }
  | { kind: "fields"; label?: string; fields: Field[] }
  | { kind: "media"; label?: string; of: Medium; source: Source }
  // A change of one text into another, shown line by line: what it removed and what it added, among the lines it kept
  // (format/diff.ts).
  | { kind: "diff"; label?: string; before: string; after: string }
);

// The parts of a content block that stands at `place` in a list of them, as parts of the block holding the list.
export function within(place: number, parts: Part[]): Part[] {
  return parts.map((part) => ({ ...part, id: `content/${place}/${part.id}` }));
}

// A field: a name and its value, a text, or the fields it holds, shown under it. A header is one, its value a text.
export type Field = [name: string, value: string | Field[]];

// A field as the line it shows: its name at its depth among the fields holding it, and its value, none for a field that
// holds fields, whose lines follow it a depth deeper. `path`: the names of the fields holding it, then its own, each
// with how many fields of that name come before it among its siblings, as HTTP repeats a header in the order it was
// sent (RFC 9110, 5.3): what names the line whatever fields are added beside it.
export type FieldLine = { name: string; value: string | undefined; depth: number; path: FieldPath };
export type FieldPath = [name: string, repeat: number][];
export function fieldLines(fields: Field[], holding: FieldPath = []): FieldLine[] {
  const seen = new Map<string, number>();
  return fields.flatMap(([name, value]) => {
    const repeat = seen.get(name) ?? 0;
    seen.set(name, repeat + 1);
    const line = { name, depth: holding.length, path: [...holding, [name, repeat]] satisfies FieldPath };
    return typeof value === "string" ? [{ ...line, value }] : [{ ...line, value: undefined }, ...fieldLines(value, line.path)];
  });
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

// A value as the part `id` showing it: its fields when it holds any, else the JSON text a field would show it as.
export function valuePart(id: string, value: unknown): Part {
  const shown = fieldValue(value);
  return typeof shown === "string" ? { id, kind: "text", form: "verbatim", text: shown } : { id, kind: "fields", fields: shown };
}

// The fields of `value` at each of `paths`, a path its field names joined by dots, named by it, those it holds, as the
// part `id`: what a block's line previews of a value that holds more than a line would.
export function pickedPart(id: string, value: unknown, paths: string[]): Extract<Part, { kind: "fields" }> {
  const held = paths.map((path): [string, unknown] => [path, path.split(".").reduce(fieldOf, value)]);
  return { id, kind: "fields", fields: held.filter(([, member]) => member !== undefined).map(([path, member]) => [path, fieldValue(member)]) };
}

// [LAW:one-source-of-truth] The id and label of a part named among its block's parts by the label it shows.
export const labelled = (name: string) => ({ id: name, label: name });

// An object's fields as the part `named`, by its id and label, when it has any.
export function fieldsParts(named: { id: string; label: string }, object: Record<string, unknown>): Extract<Part, { kind: "fields" }>[] {
  const fields = Object.entries(object).map(([name, value]): Field => [name, fieldValue(value)]);
  return fields.length === 0 ? [] : [{ ...named, kind: "fields", fields }];
}

// Why a value is not shown as what it was read as, set before the value as it was received.
export const doesNotFit = (reason: string): Part => ({ ...labelled("does not fit"), kind: "text", form: "verbatim", text: reason });

// The text a JSON part shows. [LAW:one-source-of-truth] Serialized once per part, which the formatter keeps the same
// object while its side of the exchange is unchanged, for the block's size, its view and the search; the cache is this
// function's own.
const jsonTexts = new WeakMap<Extract<Part, { kind: "json" }>, string>();
export function jsonText(part: Extract<Part, { kind: "json" }>): string {
  const text = jsonTexts.get(part) ?? JSON.stringify(part.value, null, 2) ?? "undefined";
  jsonTexts.set(part, text);
  return text;
}
