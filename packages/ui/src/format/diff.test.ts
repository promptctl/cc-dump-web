import { describe, expect, it } from "vitest";
import { lineDiff, type DiffLine } from "./diff.ts";

const same = (text: string): DiffLine => ({ change: "same", text });
const removed = (text: string): DiffLine => ({ change: "removed", text });
const added = (text: string): DiffLine => ({ change: "added", text });

// The text a side of the diff holds: its lines, kept and its own, rejoined.
const side = (lines: DiffLine[], dropped: "removed" | "added") =>
  lines
    .filter((line) => line.change !== dropped)
    .map((line) => line.text)
    .join("\n");

describe("lineDiff", () => {
  it("keeps every line of two equal texts", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([same("a"), same("b")]);
  });

  it("marks a line replaced in context as removed, then added, between the lines it kept", () => {
    expect(lineDiff("one\ntwo\nthree", "one\n2\nthree")).toEqual([same("one"), removed("two"), added("2"), same("three")]);
  });

  it("marks lines inserted and lines deleted, and nothing else", () => {
    expect(lineDiff("a\nc", "a\nb\nc")).toEqual([same("a"), added("b"), same("c")]);
    expect(lineDiff("a\nb\nc", "a\nc")).toEqual([same("a"), removed("b"), same("c")]);
  });

  it("marks an emptied text's lines removed and a new text's lines added", () => {
    expect(lineDiff("x\ny", "")).toEqual([removed("x"), removed("y"), added("")]);
    expect(lineDiff("", "x")).toEqual([removed(""), added("x")]);
  });

  it("keeps a trailing newline as the empty line after it", () => {
    expect(lineDiff("a\n", "a")).toEqual([same("a"), removed("")]);
  });

  it("finds a shortest edit, so a long text changed in one line differs in that line alone", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const changed = lines.map((line, index) => (index === 250 ? "changed" : line));
    const diff = lineDiff(lines.join("\n"), changed.join("\n"));
    expect(diff.filter((line) => line.change !== "same")).toEqual([removed("line 250"), added("changed")]);
  });

  it("holds each side whole, verbatim, in its kept and its own lines", () => {
    const before = "  if (x) {\n\treturn 1;\n  }\n";
    const after = "  if (y) {\n\treturn 1;\n  }\n  return 0;\n";
    const diff = lineDiff(before, after);
    expect(side(diff, "added")).toBe(before);
    expect(side(diff, "removed")).toBe(after);
  });
});
