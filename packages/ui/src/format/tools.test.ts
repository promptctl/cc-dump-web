import { describe, expect, it } from "vitest";
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
      { kind: "text", form: "verbatim", label: "command", text: "git status --short" },
      {
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
      { kind: "fields", fields: [["file_path", "/src/app.ts"]] },
      {
        kind: "diff",
        label: "old_string → new_string",
        lines: [
          { change: "same", text: "const a = 1;" },
          { change: "removed", text: "const b = 2;" },
          { change: "added", text: "const b = 3;" },
        ],
      },
      { kind: "fields", fields: [["replace_all", "false"]] },
    ]);
  });

  it("shows a Write as its file and the content written, verbatim", () => {
    expect(inputParts("Write", write)).toEqual([
      { kind: "fields", fields: [["file_path", "/tmp/plan.md"]] },
      { kind: "text", form: "verbatim", label: "content", text: "# Plan\n\n- one\n" },
    ]);
  });

  it("shows a Read, a Grep and a Glob as their fields, in the order they were sent", () => {
    expect(inputParts("Read", read)).toEqual([
      {
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
        kind: "fields",
        fields: [
          ["pattern", "requestAnimationFrame"],
          ["path", "packages/ui/src"],
          ["output_mode", "content"],
          ["-n", "true"],
        ],
      },
    ]);
    expect(inputParts("Glob", { pattern: "**/*.ts" })).toEqual([{ kind: "fields", fields: [["pattern", "**/*.ts"]] }]);
  });

  it("shows a field that is not a line of text as its JSON, under its name", () => {
    expect(inputParts("Bash", { command: "ls", env: { CI: "1" } })).toEqual([
      { kind: "text", form: "verbatim", label: "command", text: "ls" },
      { kind: "json", label: "env", value: { CI: "1" } },
    ]);
  });

  it("shows the input of a tool with no entry as the JSON it was sent", () => {
    const input = { description: "Find longest word", prompt: "Read notes.txt", subagent_type: "general-purpose" };
    expect(inputParts("Agent", input)).toEqual([{ kind: "json", label: "input", value: input }]);
  });

  it("shows an input its entry cannot read as why, and its JSON", () => {
    const input = { file_path: "/src/app.ts", old_string: "a" };
    expect(inputParts("Edit", input)).toEqual([
      { kind: "text", form: "verbatim", label: "does not fit", text: "input's new_string is not a string" },
      { kind: "json", label: "input", value: input },
    ]);
    expect(inputParts("Read", ["/tmp/x"])).toEqual([
      { kind: "text", form: "verbatim", label: "does not fit", text: "input is not an object" },
      { kind: "json", label: "input", value: ["/tmp/x"] },
    ]);
  });
});
