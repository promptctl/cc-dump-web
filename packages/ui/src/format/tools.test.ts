import { describe, expect, it } from "vitest";
import { formatBlock } from "./blocks.ts";
import { inputParts } from "./tools.ts";

// Inputs as Claude Code sent them, taken from recordings.
const bash = { command: "git status --short", description: "Show working tree status", timeout: 120000, run_in_background: false };
const read = { file_path: "/tmp/m1g-play/notes.txt", offset: 10, limit: 50 };
const write = { file_path: "/tmp/plan.md", content: "# Plan\n\n- one\n" };
const edit = { file_path: "/src/app.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;", replace_all: false };
const grep = { pattern: "requestAnimationFrame", path: "packages/ui/src", output_mode: "content", "-n": true };

describe("inputParts", () => {
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

  it("shows the input of a tool with no entry as the JSON it was sent", () => {
    const input = { description: "Find longest word", prompt: "Read notes.txt", subagent_type: "general-purpose" };
    expect(inputParts("Agent", input)).toEqual([{ kind: "json", id: "input", label: "input", value: input }]);
  });

  it("shows an input its entry cannot read as why, and its JSON", () => {
    const input = { file_path: "/src/app.ts", old_string: "a" };
    expect(inputParts("Edit", input)).toEqual([
      { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "input's new_string is not a string" },
      { kind: "json", id: "input", label: "input", value: input },
    ]);
    expect(inputParts("Read", ["/tmp/x"])).toEqual([
      { kind: "text", form: "verbatim", id: "misfit", label: "does not fit", text: "input is not an object" },
      { kind: "json", id: "input", label: "input", value: ["/tmp/x"] },
    ]);
  });
});

describe("a tool use", () => {
  it("reads a client tool's input by the tool's shape, and a server's or an MCP server's tool's as its JSON, whatever its name", () => {
    const use = (type: string, input: unknown) => formatBlock({ type, id: "t1", name: "Bash", input }, "assistant", "markdown").parts;
    expect(use("tool_use", { command: "ls" })).toEqual([{ kind: "text", form: "verbatim", id: "command", label: "command", text: "ls" }, { id: "id", kind: "fields", fields: [["id", "t1"]] }]);
    for (const type of ["server_tool_use", "mcp_tool_use"]) {
      expect(use(type, { cmd: "ls" })).toEqual([{ kind: "json", id: "input", label: "input", value: { cmd: "ls" } }, { id: "id", kind: "fields", fields: [["id", "t1"]] }]);
    }
  });
});
