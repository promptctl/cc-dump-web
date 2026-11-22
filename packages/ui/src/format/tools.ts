import { fields, kinds, optional, readShown, refusalOf, value, whole, type Fields, type Readers, type Unread } from "@cc-dump/log/json";
import type { Header } from "@cc-dump/proxy/format";
import type { Launch } from "./blocks.ts";
import { doesNotFit, type Part } from "./parts.ts";

// A tool call's input, shown as the tool's work: a command as the shell line it is, an edit as the change it makes, a
// file as the file. Every byte stays verbatim (docs/design/02-design.md, "Two voices"): a tool's entry arranges its
// input, it never rewrites it.

// What a call's input shows, and what the call launches, from one read of its input.
export type Called = { parts: Part[]; launches: Launch | undefined };

// A tool's entry: what a call of it shows and launches, from its input as sent; and what one whose input is still
// arriving launches, from none of it.
type Tool = { read: (input: unknown) => Called; launches: Launch | undefined };

// [LAW:no-silent-failure] An input its entry cannot read shows why, and its JSON, so a tool whose input changes shape is
// seen, not dropped; what of it read still says what the call launches.
const misfit = (why: string, input: unknown): Part[] => [doesNotFit(why), ...jsonInput(input)];

// [LAW:one-type-per-behavior] A tool's entry: the fields of its input it reads; the parts it shows, from the input read
// whole and the read, whose fields no reader names it shows too; and what a call launches, from what of its input read.
function tool<I>(readers: Readers<I>, parts: (input: I, read: Fields<I>) => Part[], launches: (input: Partial<I>) => Launch | undefined = () => undefined): Tool {
  const input = fields(readers);
  return {
    read: (json) => {
      const shown = readShown(input, json);
      if (shown.is === "refused") return { parts: misfit(shown.why, json), launches: launches({}) };
      const read = shown.read.value;
      return { parts: read.refused.length === 0 ? parts(whole(read, []), read) : misfit(refusalOf(read.refused, []), json), launches: launches(read.value) };
    },
    launches: launches({}),
  };
}

const string = value(kinds.string);
// An input arranged by its entry: its parts, then its fields no reader names.
const arranged =
  <I,>(parts: (input: I) => Part[]) =>
  (input: I, read: Fields<I>): Part[] => [...parts(input), ...unreadInputParts(read.unread)];
// An input shown as the JSON it was sent, for a tool read for what its call launches.
const asSent = <I,>(_: I, read: Fields<I>): Part[] => jsonInput(read.sent);

// [LAW:one-type-per-behavior] The tools whose input this build reads, by name, as Claude Code sends them. What a call
// states, by the tool, as seen on Claude Code's traffic, 2026-11-17: its Agent tool launches a subagent, sending its
// input's `prompt` as the subagent's first message, to the agent its `subagent_type` names, so a call launches one
// whatever its input holds, of the type it names where that reads; its Skill tool runs the `skill` its input names, so
// a call whose skill does not read, or has not arrived, launches none.
const tools: Readonly<Record<string, Tool>> = {
  Bash: tool<{ command: string }>({ command: string }, arranged(({ command }) => [{ id: "command", label: "command", kind: "text", form: "verbatim", text: command }])),
  Edit: tool<{ file_path: string; old_string: string; new_string: string }>(
    { file_path: string, old_string: string, new_string: string },
    arranged(({ file_path, old_string, new_string }) => [
      { id: "file_path", kind: "fields", fields: [["file_path", file_path]] },
      { id: "change", label: "old_string → new_string", kind: "diff", before: old_string, after: new_string },
    ]),
  ),
  Write: tool<{ file_path: string; content: string }>(
    { file_path: string, content: string },
    arranged(({ file_path, content }) => [
      { id: "file_path", kind: "fields", fields: [["file_path", file_path]] },
      { id: "content", label: "content", kind: "text", form: "verbatim", text: content },
    ]),
  ),
  // An input all of whose fields read as fields has an entry that reads none of them.
  Read: tool({}, arranged(() => [])),
  Grep: tool({}, arranged(() => [])),
  Glob: tool({}, arranged(() => [])),
  Agent: tool<{ subagent_type?: string; prompt?: string }>({ subagent_type: optional(string), prompt: optional(string) }, asSent, ({ subagent_type }) => ({
    tool: "Agent",
    type: subagent_type,
  })),
  Skill: tool<{ skill: string }>({ skill: string }, asSent, ({ skill }) => (skill === undefined ? undefined : { tool: "Skill", skill })),
};

// A tool's input as the JSON it was sent.
const jsonInput = (input: unknown): Part[] => [{ id: "input", label: "input", kind: "json", value: input }];

// The input of a call as a stream has sent it so far: JSON not yet whole, shown as the text it is, the input's deltas'
// `partial_json` joined, another text than the input it becomes.
const soFar = (input: string): Part[] => [{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: input }];

// A tool with no entry, and a server's or an MCP server's, whose names are their own and may be any: its input as the
// JSON it was sent, launching nothing.
const asJson: Tool = { read: (input) => ({ parts: jsonInput(input), launches: undefined }), launches: undefined };

// A call of `tool`. The API sends an object, so a string is the JSON a stream has sent so far.
const call = (tool: Tool, input: unknown): Called => (typeof input === "string" ? { parts: soFar(input), launches: tool.launches } : tool.read(input));

// A call of the client tool `name`, its input read by the tool's entry, looked up as an own key, so a tool named
// `constructor` is one with no entry.
export const called = (name: string, input: unknown): Called => call(Object.hasOwn(tools, name) ? tools[name]! : asJson, input);

// A call of a server's or an MCP server's tool.
export const calledAsJson = (input: unknown): Called => call(asJson, input);

// The fields of an input its entry did not read: the ones a line holds, a string, a number or a boolean, as fields, in
// the order they were sent, and the others together as the input's JSON.
function unreadInputParts(unread: readonly Unread[]): Part[] {
  const fields: Header[] = unread.flatMap(({ key, value }) => (isScalar(value) ? [[key, String(value)] satisfies Header] : []));
  const values = unread.filter(({ value }) => !isScalar(value));
  return [
    ...(fields.length === 0 ? [] : [{ id: "input fields", kind: "fields" as const, fields }]),
    ...(values.length === 0 ? [] : jsonInput(Object.fromEntries(values.map(({ key, value }) => [key, value])))),
  ];
}

const isScalar = (value: unknown): value is string | number | boolean => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
