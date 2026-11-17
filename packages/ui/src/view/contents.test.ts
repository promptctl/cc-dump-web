import { describe, expect, it } from "vitest";
import { contentsOf, farApart } from "./contents.ts";
import { LONG } from "./regions.ts";
import { render } from "./rendering.ts";

const contents = (text: string) => contentsOf(render(text, "markdown").runs);

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}\n`).join("");

describe("contentsOf", () => {
  it("lists every heading in the order it is read, by its words, its line and how many lines stand under it", () => {
    expect(contents("intro\n\n# One *more*\n\nalpha\n\n## Deep `code` and a [link](https://example.com)\n\nbeta\n\n# Two\n")).toEqual([
      { title: "One more", line: 2, level: 0, lines: 6, folds: [2] },
      { title: "Deep code and a link", line: 6, level: 1, lines: 2, folds: [2, 6] },
      // A heading nothing stands under has no section of its own to open.
      { title: "Two", line: 10, level: 0, lines: 0, folds: [] },
    ]);
  });

  it("says of each heading how many sections it stands in, whatever its depth", () => {
    expect(contents("### Deep first\n\na\n\n# Top\n\nb\n\n#### Far under\n\nc\n").map(({ title, level }) => [title, level])).toEqual([
      ["Deep first", 0],
      ["Top", 0],
      ["Far under", 1],
    ]);
  });

  it("lists a heading in a quote, a list item and a tagged section, under the section each stands in", () => {
    expect(contents("# Rules\n\n> ## Quoted\n> x\n\n- item\n\n  ### In item\n\n  y\n\n<notes>\n## Inside\n\nz\n</notes>\n")).toMatchObject([
      { title: "Rules", level: 0, folds: [0] },
      { title: "Quoted", level: 1, folds: [0, 2] },
      { title: "In item", level: 1, folds: [0, 7] },
      { title: "Inside", level: 1, folds: [0, 12] },
    ]);
  });

  it("opens the long region a heading stands in, with its section", () => {
    expect(contents("# Top\n\n<system-reminder>\n## Reminded\n\n" + lines(LONG) + "</system-reminder>\n")).toMatchObject([
      { title: "Top", folds: [0] },
      { title: "Reminded", level: 1, folds: [0, 2, 3] },
    ]);
  });

  it("lists nothing of a text with no heading, or one read verbatim", () => {
    expect(contents("no heading\n\n- here\n")).toEqual([]);
    expect(contentsOf(render("# Not a heading\n\nx\n", "verbatim").runs)).toEqual([]);
  });
});

describe("farApart", () => {
  it("holds of headings whose first and last stand more than LONG lines apart", () => {
    expect(farApart(contents("# One\n\n" + lines(LONG) + "\n# Two\n"))).toBe(true);
    // Two headings a few lines apart are in one place already, however long the text after them.
    expect(farApart(contents("# One\n\nx\n\n# Two\n\n" + lines(LONG * 2)))).toBe(false);
    // LONG lines apart is not more than LONG, as a region of LONG lines is not long.
    expect(farApart(contents("# One\n" + lines(LONG) + "# Two\n"))).toBe(true);
    expect(farApart(contents("# One\n" + lines(LONG - 1) + "# Two\n"))).toBe(false);
    expect(farApart(contents("# Alone\n\n" + lines(LONG * 2)))).toBe(false);
    expect(farApart(contents("none\n"))).toBe(false);
  });
});
