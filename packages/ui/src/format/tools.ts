import { fields, kinds, optional, raw, value, when, type Field, type Outcomes, type Reader, type Readers, type Whole } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import type { Launch } from "./blocks.ts";
import type { Part } from "./parts.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// [LAW:types-are-the-program] How a tool's call reads its input: `input`, its reader; `show`, the parts the input read
// whole shows, beside `held`, the input's fields its reader did not read; and `launches`, what a call of the tool
// launches, by how its input read, or with none read yet, as while it streams.
export type Tool<T> = {
  input: Reader<T>;
  show: (input: Whole<T>, held: Record<string, unknown>) => Part[];
  launches?: (input: Field<T>) => Launch | undefined;
};
// A tool whatever its input's type, given to `use`, which reads it as its own.
export type AnyTool = <R>(use: <T>(tool: Tool<T>) => R) => R;
const known =
  <T>(tool: Tool<T>): AnyTool =>
  (use) =>
    use(tool);

// A tool whose entry reads the fields of its input it arranges, by `readers`, and shows the others after them.
const arranged = <T>(readers: Readers<T>, show: (input: Whole<Outcomes<T>>) => Part[], launches?: (input: Field<Outcomes<T>>) => Launch | undefined): AnyTool =>
  known({ input: fields(readers), show: (input, held) => [...show(input), ...heldParts(held)], ...(launches === undefined ? {} : { launches }) });

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];

// [LAW:one-type-per-behavior] A tool with no entry, a server's or an MCP server's among them: its input as its JSON.
export const anyTool = known({ input: raw, show: jsonInput });

const text = value(kinds.string);
const pathPart = (file_path: string): Part => ({ id: "file_path", kind: "fields", fields: [["file_path", file_path]] });

// [LAW:one-type-per-behavior] The tools whose calls Claude Code sends, by name, a tool one entry. An input all of whose
// fields read as fields has an entry that reads none of them. What a call states, by the tool, as seen on Claude Code's
// traffic, 2026-11-17: its Agent tool launches a subagent, to the agent its `subagent_type` names, whatever its input
// holds, of the type it names once that is read; its Skill tool runs the `skill` its input names, so one whose input has
// not read launches none yet.
const tools = new Map<string, AnyTool>([
  ["Bash", arranged({ command: text }, ({ command }) => [{ id: "command", label: "command", kind: "text", form: "verbatim", text: command }])],
  [
    "Edit",
    arranged({ file_path: text, old_string: text, new_string: text }, ({ file_path, old_string, new_string }) => [
      pathPart(file_path),
      { id: "change", label: "old_string → new_string", kind: "diff", before: old_string, after: new_string },
    ]),
  ],
  ["Write", arranged({ file_path: text, content: text }, ({ file_path, content }) => [pathPart(file_path), { id: "content", label: "content", kind: "text", form: "verbatim", text: content }])],
  ["Read", arranged({}, () => [])],
  ["Grep", arranged({}, () => [])],
  ["Glob", arranged({}, () => [])],
  [
    "Agent",
    arranged(
      { subagent_type: optional(text) },
      ({ subagent_type }) => (subagent_type === undefined ? [] : [{ id: "subagent_type", kind: "fields", fields: [["subagent_type", subagent_type]] }]),
      (input) => ({ tool: "Agent", type: when(input, ({ fields }) => when(fields.subagent_type, (type) => type, undefined), undefined) }),
    ),
  ],
  [
    "Skill",
    arranged(
      { skill: text },
      ({ skill }) => [{ id: "skill", kind: "fields", fields: [["skill", skill]] }],
      (input) => when(input, ({ fields }) => when(fields.skill, (skill): Launch => ({ tool: "Skill", skill }), undefined), undefined),
    ),
  ],
]);

// The tool a client tool's call names, by the name as sent where it is a string: a tool with no entry, or a name that is
// none, shows its input as its JSON.
export const toolNamed = (name: unknown): AnyTool => (kinds.string.fits(name) ? (tools.get(name) ?? anyTool) : anyTool);

// The fields of an input its entry did not read: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function heldParts(held: Record<string, unknown>): Part[] {
  const rest = Object.entries(held);
  const fields: Header[] = rest.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = rest.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
