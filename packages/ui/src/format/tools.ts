import { kinds, object, readShown, value, type Reader, type Unread } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import { doesNotFit, type Part } from "./parts.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// A tool's entry: the declaration of the input fields it arranges, and the parts it arranges them as. The fields it does
// not read follow (`unreadInputParts`). [LAW:no-silent-failure] An input its declaration refuses shows why, and its
// JSON, so a tool whose input changes shape is seen, not dropped.
const tool =
  <T>(reader: Reader<T>, parts: (input: T) => Part[]) =>
  (input: unknown): Part[] => {
    const read = readShown(reader, input);
    return "refused" in read ? [doesNotFit(read.refused), ...jsonInput(input)] : [...parts(read.value), ...unreadInputParts(read.unread)];
  };

const string = value(kinds.string);
// An input all of whose fields read as fields has an entry that reads none of them.
const fieldsOnly = tool(object<Record<never, never>>({}), () => []);

// [LAW:one-type-per-behavior] The parts a tool's input shows, by the tool's name, a tool one entry.
const entries = new Map<string, (input: unknown) => Part[]>([
  ["Bash", tool(object<{ command: string }>({ command: string }), ({ command }) => [{ id: "command", label: "command", kind: "text", form: "verbatim", text: command }])],
  [
    "Edit",
    tool(object<{ file_path: string; old_string: string; new_string: string }>({ file_path: string, old_string: string, new_string: string }), (input) => [
      { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
      { id: "change", label: "old_string → new_string", kind: "diff", before: input.old_string, after: input.new_string },
    ]),
  ],
  [
    "Write",
    tool(object<{ file_path: string; content: string }>({ file_path: string, content: string }), (input) => [
      { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
      { id: "content", label: "content", kind: "text", form: "verbatim", text: input.content },
    ]),
  ],
  ["Read", fieldsOnly],
  ["Grep", fieldsOnly],
  ["Glob", fieldsOnly],
]);

// The parts a client tool's call, a tool_use block, shows its input as. A tool with no entry shows the JSON it was sent.
export function inputParts(name: string, input: unknown): Part[] {
  return (entries.get(name) ?? jsonInput)(input);
}

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];

// The fields of an input its entry did not read, each a field of the input itself: the ones a line holds, a string, a
// number or a boolean, as fields, in the order they were sent, and the others together as the input's JSON.
function unreadInputParts(unread: readonly Unread[]): Part[] {
  const named = unread.map(({ at, value }) => [at.join("."), value] as const);
  const fields: Header[] = named.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = named.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
