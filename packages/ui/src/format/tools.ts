import { fieldOf, held, kinds, object, value, type Path, type Readers, type Unknown } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import { doesNotFit, type Part } from "./parts.ts";

// A client tool's call, by the tool it calls: its input shown as the tool's work, a command as the shell line it is, an
// edit as the change it makes, a file as the file; and what the call launches and whether it waits. Every byte stays
// verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its input, it never rewrites it.

// What a call launches: an Agent call a subagent, of the agent `type` it names where it names one; a Skill call the
// skill it names, which runs in a subagent when the skill forks.
export type Launch = { tool: "Agent"; type: string | undefined } | { tool: "Skill"; skill: string };
// [LAW:one-source-of-truth] What a launch is called where it is shown: an Agent call's agent type, where it names one,
// and a Skill call's skill as the command that runs it, so a skill and an agent type of one name read apart.
export const launchName = (launches: Launch): string | undefined => (launches.tool === "Agent" ? launches.type : `/${launches.skill}`);

// [LAW:one-type-per-behavior] A client tool: the parts its input shows (`input`'s JSON for a tool with none); what its
// call launches, read off its input; and `waits: false` for the one tool whose call the reply making it does not wait
// on. As seen on Claude Code's traffic, 2026-11-17: its Agent tool sends its input's `prompt` as a subagent's first
// message, to the agent its `subagent_type` names, so an Agent call launches an agent whatever its input holds; its
// Skill tool runs the `skill` its input names, so one whose input is still streaming text launches none yet; a subagent
// hands its report back with SubagentHandback, the last block of a reply that stops for a tool's use, where its turn
// never ends.
type Tool = { parts?: (input: unknown, at: Path) => Part[]; launches?: (input: unknown) => Launch | undefined; waits?: false };

// The name a tool's input gives a field, where it gives one as text.
const named = (input: unknown, name: string): string | undefined => {
  const text = fieldOf(input, name);
  return kinds.string.fits(text) ? text : undefined;
};

// [LAW:parse-dont-validate] The parts of an input read by `readers`, the fields its entry arranges, then the fields it
// does not read; or, for one they refuse, why, and its JSON, so a tool whose input changes shape is seen, not dropped.
const arranged =
  <I>(readers: Readers<I>, parts: (input: I) => Part[]) =>
  (input: unknown, at: Path): Part[] => {
    const read = held(object(readers))(input, at);
    return read.value.is === "read" ? [...parts(read.value.value), ...unreadInputParts(read.unknown)] : [doesNotFit(read.value.refusals), ...jsonInput(input)];
  };
const text = value(kinds.string);

// [LAW:one-type-per-behavior] Each client tool this view knows, one entry each, by its name. A tool not here shows its
// input's JSON, launches nothing, and is waited on.
const tools = new Map<string, Tool>([
  ["Bash", { parts: arranged({ command: text }, ({ command }) => [{ id: "command", label: "command", kind: "text", form: "verbatim", text: command }]) }],
  [
    "Edit",
    {
      parts: arranged({ file_path: text, old_string: text, new_string: text }, (input) => [
        { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
        { id: "change", label: "old_string → new_string", kind: "diff", before: input.old_string, after: input.new_string },
      ]),
    },
  ],
  [
    "Write",
    {
      parts: arranged({ file_path: text, content: text }, (input) => [
        { id: "file_path", kind: "fields", fields: [["file_path", input.file_path]] },
        { id: "content", label: "content", kind: "text", form: "verbatim", text: input.content },
      ]),
    },
  ],
  // An input all of whose fields read as fields has an entry that reads none of them.
  ["Read", { parts: arranged({}, () => []) }],
  ["Grep", { parts: arranged({}, () => []) }],
  ["Glob", { parts: arranged({}, () => []) }],
  ["Agent", { launches: (input) => ({ tool: "Agent", type: named(input, "subagent_type") }) }],
  [
    "Skill",
    {
      launches: (input) => {
        const skill = named(input, "skill");
        return skill === undefined ? undefined : { tool: "Skill", skill };
      },
    },
  ],
  ["SubagentHandback", { waits: false }],
]);

// The parts a client tool's call, a tool_use block, shows its input at `at` as.
export function inputParts(name: string, input: unknown, at: Path): Part[] {
  return tools.get(name)?.parts?.(input, at) ?? jsonInput(input);
}

// What a call of the tool `name` with `input` launches, and whether the reply that makes it waits for its result.
export function callOf(name: string, input: unknown): { launches: Launch | undefined; waits: boolean } {
  const tool = tools.get(name);
  return { launches: tool?.launches?.(input), waits: tool?.waits ?? true };
}

// A tool's input as the JSON it was sent.
export const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];

// The fields of an input its entry did not read: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function unreadInputParts(unknown: readonly Unknown[]): Part[] {
  const rest = unknown.map(({ at, value }) => [at.at(-1)!, value] as const);
  const fields: Header[] = rest.filter(([, value]) => isScalar(value)).map(([name, value]) => [name, String(value)]);
  const values = rest.filter(([, value]) => !isScalar(value));
  return [...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]), ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values)))];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
