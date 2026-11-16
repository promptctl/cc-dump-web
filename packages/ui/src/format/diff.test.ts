import { describe, expect, it } from "vitest";
import { lineDiff, wordDiff, type Edit } from "./diff.ts";

const same = (text: string): Edit => ({ change: "same", text });
const removed = (text: string): Edit => ({ change: "removed", text });
const added = (text: string): Edit => ({ change: "added", text });

// The text a side of the diff holds: its lines, kept and its own, rejoined.
const side = (lines: Edit[], dropped: "removed" | "added") =>
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

  it("marks an emptied text's lines removed and a new text's lines added, an empty text having none", () => {
    expect(lineDiff("x\ny", "")).toEqual([removed("x"), removed("y")]);
    expect(lineDiff("", "x")).toEqual([added("x")]);
    expect(lineDiff("", "")).toEqual([]);
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

  it("shows a change of more edits than it searches as one text's lines removed and the other's added, between the lines both keep", () => {
    const text = (prefix: string) => Array.from({ length: 3000 }, (_, index) => `${prefix} ${index}`).join("\n");
    const before = `head\n${text("old")}\ntail`;
    const after = `head\n${text("new")}\ntail`;
    const diff = lineDiff(before, after);
    expect(side(diff, "added")).toBe(before);
    expect(side(diff, "removed")).toBe(after);
    expect(diff.map((line) => line.change)).toEqual(["same", ...Array<string>(3000).fill("removed"), ...Array<string>(3000).fill("added"), "same"]);
  });

  it("holds each side whole, verbatim, in its kept and its own lines", () => {
    const before = "  if (x) {\n\treturn 1;\n  }\n";
    const after = "  if (y) {\n\treturn 1;\n  }\n  return 0;\n";
    const diff = lineDiff(before, after);
    expect(side(diff, "added")).toBe(before);
    expect(side(diff, "removed")).toBe(after);
  });
});

describe("wordDiff", () => {
  it("marks the words a line changed, apart from the spaces and punctuation around them, each run joined", () => {
    expect(wordDiff("max_tokens: 32000, effort high", "max_tokens: 64000, effort high")).toEqual([same("max_tokens: "), removed("32000"), added("64000"), same(", effort high")]);
    expect(wordDiff("a b", "a new b")).toEqual([same("a "), added("new "), same("b")]);
  });

  it("reads a word in any script whole, and never cuts a character a reader sees as one", () => {
    expect(wordDiff("le café noir", "le thé noir")).toEqual([same("le "), removed("café"), added("thé"), same(" noir")]);
    expect(wordDiff("नमस्ते जी", "नमस्कार जी")).toEqual([removed("नमस्ते"), added("नमस्कार"), same(" जी")]);
    expect(wordDiff("cafe\u0301 x", "cafe y")).toEqual([removed("cafe\u0301"), added("cafe"), same(" "), removed("x"), added("y")]);
    expect(wordDiff("👨‍👩‍👧 a", "👨‍👩‍👦 a")).toEqual([removed("👨‍👩‍👧"), added("👨‍👩‍👦"), same(" a")]);
  });

  it("holds each line whole, verbatim, in its kept and its own words", () => {
    const [before, after] = ["  call(x, 'one')  ", "  call(y, 'one', 2)"];
    const words = wordDiff(before, after);
    expect(words.filter(({ change }) => change !== "added").map(({ text }) => text).join("")).toBe(before);
    expect(words.filter(({ change }) => change !== "removed").map(({ text }) => text).join("")).toBe(after);
  });
});
