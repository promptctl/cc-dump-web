import { describe, expect, it } from "vitest";
import type { Block } from "../format/blocks.ts";
import { blockDiff, blockText, type LineFold, type Pair } from "./change.ts";

const block = (text: string): Block => ({ category: "system", name: "system", parts: [{ kind: "text", form: "markdown", text }] });
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
const kinds = (entries: (Pair | LineFold)[]) => entries.map((entry) => (entry.kind === "fold" ? `fold ${entry.at}+${entry.pairs.length}` : entry.kind));

describe("blockText", () => {
  it("writes each part as the diff compares it, a blank line between them, and no labels", () => {
    expect(
      blockText({
        category: "tools",
        name: "tool_use: X",
        parts: [
          { kind: "text", form: "verbatim", label: "command", text: "ls" },
          { kind: "json", value: { a: 1 } },
          { kind: "fields", fields: [["id", "1"], ["thinking", [["type", "adaptive"]]]] },
          { kind: "diff", before: "old", after: "new" },
          { kind: "media", of: "image", source: { type: "url", url: "u" } },
        ],
      }),
    ).toBe(["ls", '{\n  "a": 1\n}', "id: 1\nthinking:\n  type: adaptive", "-old\n+new", "[image: u]"].join("\n\n"));
  });
});

describe("blockDiff", () => {
  it("sets a replaced line against its replacement, marked word by word, and a line one side has more of against an empty slot", () => {
    const { entries } = blockDiff(block("keep\nmodel: a\ngone"), block("keep\nmodel: b"));
    expect(entries).toEqual([
      { kind: "same", left: { line: 0, words: [{ change: "same", text: "keep" }] }, right: { line: 0, words: [{ change: "same", text: "keep" }] } },
      {
        kind: "replaced",
        left: { line: 1, words: [{ change: "same", text: "model: " }, { change: "removed", text: "a" }] },
        right: { line: 1, words: [{ change: "same", text: "model: " }, { change: "added", text: "b" }] },
      },
      { kind: "removed", left: { line: 2, words: [{ change: "removed", text: "gone" }] }, right: undefined },
    ]);
  });

  it("folds each run of unchanged lines beyond the three beside a change, and lists a run of one", () => {
    const before = numbered(20);
    const after = before.map((line, index) => (index === 10 ? "changed" : line));
    expect(kinds(blockDiff(block(before.join("\n")), block(after.join("\n"))).entries)).toEqual([
      "fold 0+7",
      ...Array<string>(3).fill("same"),
      "replaced",
      ...Array<string>(3).fill("same"),
      "fold 14+6",
    ]);
    // Eight lines between two changes leave two beyond their context, folded; seven leave one, listed.
    const twice = (gap: number) => numbered(gap + 2).map((line, index) => (index === 0 || index === gap + 1 ? `${line}!` : line));
    expect(kinds(blockDiff(block(numbered(10).join("\n")), block(twice(8).join("\n"))).entries)).toContain("fold 4+2");
    expect(kinds(blockDiff(block(numbered(9).join("\n")), block(twice(7).join("\n"))).entries)).not.toContainEqual(expect.stringMatching(/fold/));
  });

  it("gives the right side's text, a passage a line, and each fold's characters, as the search reads it", () => {
    const after = ["new", ...numbered(9)].join("\n");
    const { right } = blockDiff(block(["old", ...numbered(9)].join("\n")), block(after));
    expect(right.text).toBe(after);
    expect(right.passages.map(({ start, end }) => right.text.slice(start, end))).toEqual(after.split("\n"));
    // Lines 4 to 9 of the right, after the change and the three beside it, are folded.
    expect(right.folds).toEqual([{ start: after.indexOf("line 3"), end: after.length, line: 4 }]);
  });

  it("diffs each pair of versions once", () => {
    const [before, after] = [block("a"), block("b")];
    expect(blockDiff(before, after)).toBe(blockDiff(before, after));
  });
});
