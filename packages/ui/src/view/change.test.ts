import { describe, expect, it } from "vitest";
import type { Block } from "../format/blocks.ts";
import { blockDiff, blockText, type DiffLine, type LineFold } from "./change.ts";

const block = (text: string): Block => ({ category: "system", name: "system", parts: [{ kind: "text", form: "markdown", text }] });
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
const kinds = (entries: (DiffLine | LineFold)[]) => entries.map((entry) => (entry.kind === "fold" ? `fold ${entry.at}+${entry.lines.length}` : entry.change));
const line = (change: DiffLine["change"], ...words: [DiffLine["change"], string][]): DiffLine => ({ kind: "line", change, words: words.map(([change, text]) => ({ change, text })) });

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

  it("tells two images of one size apart", () => {
    const image = (data: string): Block => ({ category: "user", name: "image", parts: [{ kind: "media", of: "image", source: { type: "base64", media_type: "image/png", data } }] });
    expect(blockText(image("AAAA"))).not.toBe(blockText(image("AAAB")));
  });
});

describe("blockDiff", () => {
  it("lists the lines a change removed above the lines it added, a replaced line marked word by word and any other whole", () => {
    expect(blockDiff(block("keep\nmodel: a\ngone\nlast"), block("keep\nmodel: b\nlast\nnew"))).toEqual([
      line("same", ["same", "keep"]),
      line("removed", ["same", "model: "], ["removed", "a"]),
      line("removed", ["removed", "gone"]),
      line("added", ["same", "model: "], ["added", "b"]),
      line("same", ["same", "last"]),
      line("added", ["added", "new"]),
    ]);
  });

  it("folds each run of unchanged lines beyond the three beside a change, and lists a run of one", () => {
    const before = numbered(20);
    const after = before.map((line, index) => (index === 10 ? "changed" : line));
    // The fold after the change is named by its place among the diff's lines, one further for the line replaced.
    expect(kinds(blockDiff(block(before.join("\n")), block(after.join("\n"))))).toEqual([
      "fold 0+7",
      ...Array<string>(3).fill("same"),
      "removed",
      "added",
      ...Array<string>(3).fill("same"),
      "fold 15+6",
    ]);
    // Eight lines between two changes leave two beyond their context, folded; seven leave one, listed.
    const twice = (gap: number) => numbered(gap + 2).map((line, index) => (index === 0 || index === gap + 1 ? `${line}!` : line));
    expect(kinds(blockDiff(block(numbered(10).join("\n")), block(twice(8).join("\n"))))).toContain("fold 5+2");
    expect(kinds(blockDiff(block(numbered(9).join("\n")), block(twice(7).join("\n"))))).not.toContainEqual(expect.stringMatching(/fold/));
  });

  it("diffs each pair of blocks once", () => {
    const [before, after] = [block("a"), block("b")];
    expect(blockDiff(before, after)).toBe(blockDiff(before, after));
  });
});
