import { attempt, kinds, object, parse, value, type Readers } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import { doesNotFit, type Part } from "./parts.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// A tool's entry: the fields its parts arrange, each read by its reader, then every field it does not read
// (`unreadInputParts`).
function entry<T>(readers: Readers<T>, parts: (input: T) => Part[]): (input: unknown) => Part[] {
  const read = object(readers, "keep");
  return (input) => {
    const { fields, rest } = parse(read, input, "input");
    return [...parts(fields), ...unreadInputParts(rest)];
  };
}

const text = value(kinds.string);

// [LAW:one-type-per-behavior] The parts a tool's input shows, by the tool's name, a tool one entry. An input all of whose
// fields read as fields has an entry that reads none of them.
const entries = new Map<string, (input: unknown) => Part[]>([
  ["Bash", entry({ command: text }, ({ command }) => [{ id: "command", label: "command", kind: "text", form: "verbatim", text: command }])],
  [
    "Edit",
    entry({ file_path: text, old_string: text, new_string: text }, (input) => [
      { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
      { id: "change", label: "old_string → new_string", kind: "diff", before: input.old_string, after: input.new_string },
    ]),
  ],
  [
    "Write",
    entry({ file_path: text, content: text }, (input) => [
      { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
      { id: "content", label: "content", kind: "text", form: "verbatim", text: input.content },
    ]),
  ],
  ["Read", entry({}, () => [])],
  ["Grep", entry({}, () => [])],
  ["Glob", entry({}, () => [])],
]);

// The parts a client tool's call, a tool_use block, shows its input as. A tool with no entry shows the JSON it was sent.
// [LAW:no-silent-failure] An input its entry cannot read shows why, and its JSON, so a tool whose input changes shape is
// seen, not dropped.
export function inputParts(name: string, input: unknown): Part[] {
  const read = entries.get(name);
  if (read === undefined) return jsonInput(input);
  return attempt(
    () => read(input),
    (reason) => [doesNotFit(reason), ...jsonInput(input)],
  );
}

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];

// The fields of an input its entry did not read: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function unreadInputParts(input: Record<string, unknown>): Part[] {
  const rest = Object.entries(input);
  const fields: Header[] = rest.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = rest.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
