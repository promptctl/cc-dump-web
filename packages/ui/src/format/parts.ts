import { attempt, fieldOf, parseJson } from "@cc-dump/log/json";

// What a media source is the source of: an image the view shows as one, or a document it names.
export type Medium = "image" | "document";
export type Source = { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } | { type: "file"; file_id: string };

// How a text reads (docs/design/02-design.md, "Two voices"): as Markdown, the way the model writes and reads what a
// sender wrote, or verbatim, the way a tool returned it or the proxy reports it. [LAW:one-type-per-behavior] One kind of
// text part, one rendering; the form is a value.
export type Form = "markdown" | "verbatim";

// [LAW:locality-or-seam] What a block shows, in kinds the view renders without knowing the API: a new block type, or a
// richer rendering of one, is a change to the formatter alone. `label`: the word shown over it, where it has one.
export type PartBody = { label?: string } & (
  | { kind: "text"; form: Form; text: string }
  | { kind: "json"; value: unknown }
  | { kind: "fields"; fields: Field[] }
  // [LAW:types-are-the-program] The fields of an object no read asked for, shown as fields are: a kind of its own, so
  // whatever name nesting gives the part, the history knows them as fields a resent request may leave out
  // (view/history.ts).
  | { kind: "rest"; fields: Field[] }
  | { kind: "media"; of: Medium; source: Source }
  // A change of one text into another, shown line by line: what it removed and what it added, among the lines it kept
  // (format/diff.ts).
  | { kind: "diff"; before: string; after: string }
);

// A part of a block. [LAW:types-are-the-program] [LAW:one-source-of-truth] `id`: the part's name among its block's
// parts, given where the formatter makes it, from the API's name for what it shows (`command`, `partial_json`) or the
// formatter's own (`misfit`), never from the words shown over it: so a part keeps its name, and the view what it keeps
// of the part's texts, as parts are added ahead of it, a part is made again in another kind, or its label is reworded.
export type Part = { id: string } & PartBody;

// A field: a name and its value, a text, or the fields it holds, shown under it. A header is one, its value a text.
export type Field = [name: string, value: string | Field[]];

// [LAW:types-are-the-program] Where a field stands among a part's fields: the name of each field holding it and its own,
// each with its occurrence among its siblings of that name, in the order sent, as HTTP repeats a header (RFC 9110,
// 5.3). Only a field added after its siblings of a name has an occurrence they did not, so a field's path stays its own
// as fields are added around it.
export type FieldPath = [name: string, occurrence: number][];

// [LAW:one-source-of-truth] Each item's occurrence among the items before it of the same name, counting from 0, in the
// order sent: how a field's path and a tool's key tell siblings of one name apart.
export function occurrences<T>(items: readonly T[], nameOf: (item: T) => string): number[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const name = nameOf(item);
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    return occurrence;
  });
}

// A field as the line it shows: its name, its path, and its value, none for a field that holds fields, whose lines
// follow it a depth deeper.
export type FieldLine = { name: string; value: string | undefined; path: FieldPath };
export function fieldLines(fields: Field[], holding: FieldPath = []): FieldLine[] {
  const counted = occurrences(fields, ([name]) => name);
  return fields.flatMap(([name, value], index) => {
    const path: FieldPath = [...holding, [name, counted[index]!]];
    return typeof value === "string" ? [{ name, value, path }] : [{ name, value: undefined, path }, ...fieldLines(value, path)];
  });
}

// How deep a field's line stands among the fields holding it: 0 for a part's own field.
export const depthOf = ({ path }: FieldLine): number => path.length - 1;

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
  // A string that is not JSON is a string, as it is any other.
  return attempt(
    () => {
      const value = parseJson(text, "text");
      return JSON.stringify(value) === text ? value : text;
    },
    () => text,
  );
}

// A value as the part `id` showing it: its fields when it holds any, else the JSON text a field would show it as.
export function valuePart(value: unknown, id: string): Part {
  const shown = fieldValue(value);
  return typeof shown === "string" ? { id, kind: "text", form: "verbatim", text: shown } : { id, kind: "fields", fields: shown };
}

// The fields of `value` at each of `paths`, a path its field names joined by dots, named by it, those it holds: what a
// block's line previews of a value that holds more than a line would.
export function pickedPart(value: unknown, paths: string[]): Extract<PartBody, { kind: "fields" }> {
  const held = paths.map((path): [string, unknown] => [path, path.split(".").reduce(fieldOf, value)]);
  return { kind: "fields", fields: held.filter(([, member]) => member !== undefined).map(([path, member]) => [path, fieldValue(member)]) };
}

// The fields of an object no read asked for, `rest`, as the part `named`, its id and its label, when there are any.
export function restParts(rest: Record<string, unknown>, named: { id: string; label: string }): Extract<Part, { kind: "rest" }>[] {
  const fields = Object.entries(rest).map(([name, value]): Field => [name, fieldValue(value)]);
  return fields.length === 0 ? [] : [{ ...named, kind: "rest", fields }];
}

// Why a value is not shown as what it was read as, set before the value as it was received.
export const doesNotFit = (reason: string): Part => ({ id: "misfit", label: "does not fit", kind: "text", form: "verbatim", text: reason });

// [LAW:one-source-of-truth] What a value not shown as what it was read as shows instead: why, then the value as it was
// received, its JSON or its text.
export type Received = Extract<PartBody, { kind: "json" | "text" }>;
export function receivedParts(reason: string, received: Received): Part[] {
  return [doesNotFit(reason), { id: "received", ...received }];
}

// The text a JSON part shows. [LAW:one-source-of-truth] Serialized once per part, which the formatter keeps the same
// object while its side of the exchange is unchanged, for the block's size, its view and the search; the cache is this
// function's own.
const jsonTexts = new WeakMap<Extract<PartBody, { kind: "json" }>, string>();
export function jsonText(part: Extract<PartBody, { kind: "json" }>): string {
  const text = jsonTexts.get(part) ?? JSON.stringify(part.value, null, 2) ?? "undefined";
  jsonTexts.set(part, text);
  return text;
}
