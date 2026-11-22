import { holding, kinds, object, optional, raw, value, when, type Holding, type Outcome, type Outcomes, type Reader, type Readers, type Whole } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import { fieldPart, type Part } from "./parts.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// What a call launches: an Agent call a subagent, of the agent `type` it names where it names one; a Skill call the
// skill it names, which runs in a subagent when the skill forks.
export type Launch = { tool: "Agent"; type: string | undefined } | { tool: "Skill"; skill: string };
// [LAW:one-source-of-truth] What a launch is called where it is shown: an Agent call's agent type, where it names one,
// and a Skill call's skill as the command that runs it, so a skill and an agent type of one name read apart.
export const launchName = (launches: Launch): string | undefined => (launches.tool === "Agent" ? launches.type : `/${launches.skill}`);

// [LAW:types-are-the-program] How a tool's call reads its input: `input`, its reader; `show`, the parts the input read
// whole shows; `launches`, what a call of the tool launches, by how its input read, or with none read yet, as while a
// stream sends it; and `waits`, whether the reply that makes the call waits for its result, as every call's does but a
// subagent's SubagentHandback, which hands its report back and ends its work.
export type Tool<T> = { input: Reader<T>; show: (input: Whole<T>) => Part[]; launches: (input: Input<T>) => Launch | undefined; waits: boolean };
// [LAW:types-are-the-program] How a call's input stands: read, refused or missing, as any field does, or still being
// sent by a stream, as the JSON of its input so far.
export type Input<T> = Outcome<T> | { is: "streaming" };
// A tool whatever its input's type, given to `use`, which reads it as its own.
export type AnyTool = <R>(use: <T>(tool: Tool<T>) => R) => R;
const known =
  <T>(tool: Tool<T>): AnyTool =>
  (use) =>
    use(tool);

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];
const launchesNone = () => undefined;

// [LAW:one-type-per-behavior] A tool with no entry, a server's or an MCP server's among them: its input as its JSON.
export const anyTool = known({ input: raw, show: jsonInput, launches: launchesNone, waits: true });

// A tool whose entry reads the fields of its input it arranges, by `readers`, all of which must read, and shows the
// input's others after them, as they were sent.
type Arranged<T> = Holding<Whole<Outcomes<T>>>;
const arranged = <T>(readers: Readers<T>, show: (input: Arranged<T>["read"]) => Part[], launches: (input: Input<Arranged<T>>) => Launch | undefined = launchesNone): AnyTool =>
  known<Arranged<T>>({ input: holding(object(readers)), show: ({ read, others }) => [...show(read), ...otherParts(others)], launches, waits: true });

const text = value(kinds.string);
const verbatim = (id: string, text: string): Part => ({ id, label: id, kind: "text", form: "verbatim", text });
// A tool whose entry arranges none of its input's fields, so every field reads as a field.
const unarranged = arranged({}, () => []);

// [LAW:one-type-per-behavior] The tools whose calls Claude Code sends, by name, a tool one entry. What a call states, by
// the tool, as seen on Claude Code's traffic, 2026-11-17: its Agent tool launches a subagent, whatever its input holds,
// of the type its `subagent_type` names once that is read; its Skill tool runs the `skill` its input names, so one whose
// input has not read launches none; a subagent's SubagentHandback is the one call its reply does not wait on.
const tools = new Map<string, AnyTool>([
  ["Bash", arranged({ command: text }, ({ command }) => [verbatim("command", command)])],
  [
    "Edit",
    arranged({ file_path: text, old_string: text, new_string: text }, ({ file_path, old_string, new_string }) => [
      fieldPart("file_path", file_path),
      { id: "change", label: "old_string → new_string", kind: "diff", before: old_string, after: new_string },
    ]),
  ],
  ["Write", arranged({ file_path: text, content: text }, ({ file_path, content }) => [fieldPart("file_path", file_path), verbatim("content", content)])],
  ["Read", unarranged],
  ["Grep", unarranged],
  ["Glob", unarranged],
  [
    "Agent",
    arranged(
      { subagent_type: optional(text) },
      ({ subagent_type }) => (subagent_type === undefined ? [] : [fieldPart("subagent_type", subagent_type)]),
      (input) => ({ tool: "Agent", type: input.is === "read" ? input.value.read.subagent_type : undefined }),
    ),
  ],
  [
    "Skill",
    arranged(
      { skill: text },
      ({ skill }) => [fieldPart("skill", skill)],
      (input) => (input.is === "read" ? { tool: "Skill", skill: input.value.read.skill } : undefined),
    ),
  ],
  ["SubagentHandback", known({ input: raw, show: jsonInput, launches: launchesNone, waits: false })],
]);

// The tool a client tool's call names, by how its name read: a tool with no entry, or a name that did not read, shows
// its input as its JSON. [LAW:types-are-the-program] Looked up in a Map, so `__proto__` or `constructor` names none.
export const toolNamed = (name: Outcome<string>): AnyTool => when(name, (name) => tools.get(name) ?? anyTool, anyTool);

// The fields of an input its entry did not arrange: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function otherParts(others: Record<string, unknown>): Part[] {
  const rest = Object.entries(others);
  const fields: Header[] = rest.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = rest.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
