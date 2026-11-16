import type { Header } from "@cc-dump/proxy/format";
import type { Part } from "./parts.ts";
import { fitting, readObject, type Fields } from "./read.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// [LAW:one-type-per-behavior] The parts a tool's input shows, by the tool's name, a tool one entry. Each reads the fields
// it arranges; the fields it does not read follow (`unreadParts`). An input all of whose fields read as fields has an entry
// that reads none of them.
const entries = new Map<string, (input: Fields) => Part[]>([
  ["Bash", (input) => [{ kind: "text", form: "verbatim", label: "command", text: input.string("command") }]],
  [
    "Edit",
    (input) => [
      { kind: "fields", fields: [["file_path", input.string("file_path")]] },
      { kind: "diff", label: "old_string → new_string", before: input.string("old_string"), after: input.string("new_string") },
    ],
  ],
  [
    "Write",
    (input) => [
      { kind: "fields", fields: [["file_path", input.string("file_path")]] },
      { kind: "text", form: "verbatim", label: "content", text: input.string("content") },
    ],
  ],
  ["Read", () => []],
  ["Grep", () => []],
  ["Glob", () => []],
]);

// The parts a client tool's call, a tool_use block, shows its input as. A tool with no entry shows the JSON it was sent.
// [LAW:no-silent-failure] An input its entry cannot read shows why, and its JSON, so a tool whose input changes shape is
// seen, not dropped.
export function inputParts(name: string, input: unknown): Part[] {
  const entry = entries.get(name);
  if (entry === undefined) return jsonInput(input);
  return fitting(
    () => {
      const fields = readObject(input, "input");
      return [...entry(fields), ...unreadParts(fields)];
    },
    (reason) => [{ kind: "text", form: "verbatim", label: "does not fit", text: reason }, ...jsonInput(input)],
  );
}

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ kind: "json", label: "input", value: input }];

// The fields of an input its entry did not read: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function unreadParts(input: Fields): Part[] {
  const rest = Object.entries(input.rest());
  const fields: Header[] = rest.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = rest.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
