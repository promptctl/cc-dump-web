import { describe, expect, it } from "vitest";
import { formatBlock } from "./blocks.ts";

// Inputs as Claude Code sent them, taken from recordings.
const bash = { command: "git status --short", description: "Show working tree status", timeout: 120000, run_in_background: false };
const read = { file_path: "/tmp/m1g-play/notes.txt", offset: 10, limit: 50 };
const write = { file_path: "/tmp/plan.md", content: "# Plan\n\n- one\n" };
const edit = { file_path: "/src/app.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;", replace_all: false };
const grep = { pattern: "requestAnimationFrame", path: "packages/ui/src", output_mode: "content", "-n": true };
const agent = { description: "Find longest word", prompt: "Read notes.txt", subagent_type: "general-purpose" };

// A client tool's call of `name` with `input`, as the block the view shows.
const called = (name: string, input: unknown) => formatBlock({ type: "tool_use", id: "t1", name, input }, "assistant", "markdown");
const idPart = { id: "id", kind: "fields", fields: [["id", "t1"]] };
// The parts its input shows, before its id.
const inputParts = (name: string, input: unknown) => {
  const { parts } = called(name, input);
  expect(parts.at(-1)).toEqual(idPart);
  return parts.slice(0, -1);
};

describe("a client tool's input", () => {
  it("shows a Bash call's command as the shell line it is, and its other fields as fields", () => {
    expect(inputParts("Bash", bash)).toEqual([
      { kind: "text", form: "verbatim", id: "command", label: "command", text: "git status --short" },
      {
        id: "input fields",
        kind: "fields",
        fields: [
          ["description", "Show working tree status"],
          ["timeout", "120000"],
          ["run_in_background", "false"],
        ],
      },
    ]);
  });

  it("shows an Edit as its file and the change it makes, line by line", () => {
    expect(inputParts("Edit", edit)).toEqual([
      { id: "file_path", kind: "fields", fields: [["file_path", "/src/app.ts"]] },
      {
        kind: "diff",
        id: "change",
        label: "old_string → new_string",
        before: "const a = 1;\nconst b = 2;",
        after: "const a = 1;\nconst b = 3;",
      },
      { id: "input fields", kind: "fields", fields: [["replace_all", "false"]] },
    ]);
  });

  it("shows a Write as its file and the content written, verbatim", () => {
    expect(inputParts("Write", write)).toEqual([
      { id: "file_path", kind: "fields", fields: [["file_path", "/tmp/plan.md"]] },
      { kind: "text", form: "verbatim", id: "content", label: "content", text: "# Plan\n\n- one\n" },
    ]);
  });

  it("shows a Read, a Grep and a Glob as their fields, in the order they were sent", () => {
    expect(inputParts("Read", read)).toEqual([
      {
        id: "input fields",
        kind: "fields",
        fields: [
          ["file_path", "/tmp/m1g-play/notes.txt"],
          ["offset", "10"],
          ["limit", "50"],
        ],
      },
    ]);
    expect(inputParts("Grep", grep)).toEqual([
      {
        id: "input fields",
        kind: "fields",
        fields: [
          ["pattern", "requestAnimationFrame"],
          ["path", "packages/ui/src"],
          ["output_mode", "content"],
          ["-n", "true"],
        ],
      },
    ]);
    expect(inputParts("Glob", { pattern: "**/*.ts" })).toEqual([{ id: "input fields", kind: "fields", fields: [["pattern", "**/*.ts"]] }]);
  });

  it("shows the fields that are not a line of text together as the input's JSON, whatever their names", () => {
    const input = JSON.parse('{"command": "ls", "env": {"CI": "1"}, "timeout": 5, "fields": ["a"], "__proto__": {"x": 1}}');
    expect(inputParts("Bash", input)).toEqual([
      { kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" },
      { id: "input fields", kind: "fields", fields: [["timeout", "5"]] },
      { kind: "json", id: "input", label: "input", value: JSON.parse('{"env": {"CI": "1"}, "fields": ["a"], "__proto__": {"x": 1}}') },
    ]);
  });

  it("shows an Agent call's agent type, its other fields as fields, and a Skill call's skill", () => {
    expect(inputParts("Agent", agent)).toEqual([
      { id: "subagent_type", kind: "fields", fields: [["subagent_type", "general-purpose"]] },
      {
        id: "input fields",
        kind: "fields",
        fields: [
          ["description", "Find longest word"],
          ["prompt", "Read notes.txt"],
        ],
      },
    ]);
    expect(inputParts("Skill", { skill: "review" })).toEqual([{ id: "skill", kind: "fields", fields: [["skill", "review"]] }]);
  });

  it("shows the input of a tool with no entry, and of a name that is none, as the JSON it was sent", () => {
    for (const name of ["TodoWrite", "__proto__", "toString", "constructor"]) {
      expect(inputParts(name, agent), name).toEqual([{ kind: "json", id: "input", label: "input", value: agent }]);
    }
  });

  it("shows a call whose input its entry cannot read as one reason, and the call as it was sent", () => {
    const misfit = (text: string) => ({ kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text });
    const cases: [unknown, string][] = [
      [{ file_path: "/src/app.ts", old_string: "a" }, "input: new_string: is missing"],
      [["/tmp/x"], "input: is not an object"],
    ];
    for (const [input, why] of cases) {
      expect(called("Edit", input).parts).toEqual([misfit(why), { id: "received", kind: "json", value: { type: "tool_use", id: "t1", name: "Edit", input } }]);
    }
    const unsent = formatBlock({ type: "tool_use", id: "t1", name: "Bash" }, "assistant", "markdown");
    expect(unsent.parts).toEqual([misfit("input: is missing"), { id: "received", kind: "json", value: { type: "tool_use", id: "t1", name: "Bash" } }]);
  });
});

describe("a tool use", () => {
  it("reads a client tool's input by the tool's shape, and a server's or an MCP server's tool's as its JSON, whatever its name", () => {
    const use = (type: string, input: unknown) => formatBlock({ type, id: "t1", name: "Bash", input }, "assistant", "markdown").parts;
    expect(use("tool_use", { command: "ls" })).toEqual([{ kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" }, idPart]);
    for (const type of ["server_tool_use", "mcp_tool_use"]) {
      expect(use(type, { cmd: "ls" })).toEqual([{ kind: "json", id: "input", label: "input", value: { cmd: "ls" } }, idPart]);
    }
  });

  it("states a client tool's call from the fields of it that read, whatever else does not", () => {
    expect(called("Agent", agent).call).toEqual({ id: "t1", launches: { tool: "Agent", type: "general-purpose" }, waits: true });
    // An agent type that does not read launches an agent of no type, and the block says why.
    const untyped = called("Agent", { ...agent, subagent_type: 5 });
    expect(untyped.call).toEqual({ id: "t1", launches: { tool: "Agent", type: undefined }, waits: true });
    expect(untyped.parts[0]).toMatchObject({ id: "misfit", text: "input: subagent_type: is not a string" });
    expect(called("Skill", { skill: "review" }).call).toEqual({ id: "t1", launches: { tool: "Skill", skill: "review" }, waits: true });
    expect(called("Skill", {}).call).toEqual({ id: "t1", launches: undefined, waits: true });
    expect(called("SubagentHandback", {}).call).toEqual({ id: "t1", launches: undefined, waits: false });
    // A call with no id states none; a server tool's call never does.
    expect(formatBlock({ type: "tool_use", id: 5, name: "Bash", input: { command: "ls" } }, "assistant", "markdown").call).toBeUndefined();
    expect(formatBlock({ type: "server_tool_use", id: "s1", name: "web_search", input: {} }, "assistant", "markdown").call).toBeUndefined();
  });

  it("shows a call whose input is still streaming as the text sent so far, an Agent's launching an agent of no type yet", () => {
    const streaming = formatBlock({ type: "tool_use", id: "t1", name: "Agent", partial_json: '{"subagent_' }, "assistant", "markdown");
    expect(streaming.parts).toEqual([{ id: "partial_json", label: "input so far", kind: "text", form: "verbatim", text: '{"subagent_' }, idPart]);
    expect(streaming.call).toEqual({ id: "t1", launches: { tool: "Agent", type: undefined }, waits: true });
  });
});
