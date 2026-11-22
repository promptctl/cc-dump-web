import { describe, expect, it } from "vitest";
import { contentOf, formatBlock } from "./blocks.ts";
import { called } from "./tools.ts";

// Inputs as Claude Code sent them, taken from recordings.
const bash = { command: "git status --short", description: "Show working tree status", timeout: 120000, run_in_background: false };
const read = { file_path: "/tmp/m1g-play/notes.txt", offset: 10, limit: 50 };
const write = { file_path: "/tmp/plan.md", content: "# Plan\n\n- one\n" };
const edit = { file_path: "/src/app.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;", replace_all: false };
const grep = { pattern: "requestAnimationFrame", path: "packages/ui/src", output_mode: "content", "-n": true };

// What a call of a client tool shows of its input.
const inputParts = (name: string, input: unknown) => called(name, input).parts;

describe("a call's input", () => {
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
        id: "change", label: "old_string → new_string",
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
    expect(inputParts("Bash", { command: "ls", env: { CI: "1" }, timeout: 5, fields: ["a"] })).toEqual([
      { kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" },
      { id: "input fields", kind: "fields", fields: [["timeout", "5"]] },
      { kind: "json", id: "input", label: "input", value: { env: { CI: "1" }, fields: ["a"] } },
    ]);
  });

  it("shows the input of a tool read for what its call launches, or with no entry, as the JSON it was sent", () => {
    const input = { description: "Find longest word", prompt: "Read notes.txt", subagent_type: "general-purpose" };
    expect(inputParts("Agent", input)).toEqual([{ kind: "json", id: "input", label: "input", value: input }]);
  });

  it("shows an input its entry cannot read as why, and its JSON", () => {
    const input = { file_path: "/src/app.ts", old_string: "a" };
    expect(inputParts("Edit", input)).toEqual([
      { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "new_string: is missing" },
      { kind: "json", id: "input", label: "input", value: input },
    ]);
    expect(inputParts("Read", ["/tmp/x"])).toEqual([
      { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "is not an object" },
      { kind: "json", id: "input", label: "input", value: ["/tmp/x"] },
    ]);
  });

  it("states what a call launches from what of its input read, and shows what did not beside the call", () => {
    expect(called("Agent", { subagent_type: "Explore", prompt: "Find it" }).launches).toEqual({ tool: "Agent", type: "Explore" });
    // An Agent call launches an agent whatever its input holds; a Skill call whose skill does not read launches none.
    const agent = called("Agent", { subagent_type: 7, prompt: "Find it" });
    expect(agent).toEqual({
      parts: [
        { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "subagent_type: is not a string" },
        { kind: "json", id: "input", label: "input", value: { subagent_type: 7, prompt: "Find it" } },
      ],
      launches: { tool: "Agent", type: undefined },
    });
    expect(called("Skill", { skill: "review" }).launches).toEqual({ tool: "Skill", skill: "review" });
    expect(called("Skill", { skill: ["review"] })).toMatchObject({ parts: [{ id: "misfit", text: "skill: is not a string" }, { id: "input" }], launches: undefined });
    // An input still arriving launches what its tool's calls launch whatever their input.
    expect(called("Agent", '{"subagent_type": "Exp').launches).toEqual({ tool: "Agent", type: undefined });
    expect(called("Skill", '{"skill": "rev').launches).toBeUndefined();
  });

  it("reads a tool's name and an input's fields as keys like any other, written as JSON text", () => {
    const sent = JSON.parse('{"name": "constructor", "input": {"__proto__": "x", "toString": 1, "command": "ls"}}') as { name: string; input: unknown };
    // A tool named `constructor` has no entry; an input's `__proto__` is one of its fields.
    expect(called(sent.name, sent.input)).toEqual({ parts: [{ kind: "json", id: "input", label: "input", value: sent.input }], launches: undefined });
    expect(inputParts("Bash", sent.input)).toEqual([
      { kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" },
      { id: "input fields", kind: "fields", fields: [["__proto__", "x"], ["toString", "1"]] },
    ]);
  });
});

describe("a tool use", () => {
  it("reads a client tool's input by the tool's shape, and a server's or an MCP server's tool's as its JSON, whatever its name", () => {
    const use = (type: string, input: unknown) => formatBlock(contentOf({ type, id: "t1", name: "Bash", input }), "assistant", "markdown").parts;
    expect(use("tool_use", { command: "ls" })).toEqual([{ kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" }, { id: "id", kind: "fields", fields: [["id", "t1"]] }]);
    for (const type of ["server_tool_use", "mcp_tool_use"]) {
      expect(use(type, { cmd: "ls" })).toEqual([{ kind: "json", id: "input", label: "input", value: { cmd: "ls" } }, { id: "id", kind: "fields", fields: [["id", "t1"]] }]);
    }
  });
});
