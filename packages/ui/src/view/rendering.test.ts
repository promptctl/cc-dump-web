import { describe, expect, it } from "vitest";
import { LONG } from "./regions.ts";
import { regionsAround, render, renderingOf, type Block, type Inline, type Leaf, type Rendering, type Run } from "./rendering.ts";
import { find } from "./search.ts";

// Every leaf a rendering draws, in order.
function leaves(runs: Run[]): Leaf[] {
  return runs.flatMap((run): Leaf[] => {
    switch (run.kind) {
      case "verbatim":
        return [run.leaf];
      case "markdown":
        return run.blocks.flatMap(blockLeaves);
      case "region":
        return [run.open, ...leaves(run.body), run.close];
    }
  });
}
function blockLeaves(block: Block): Leaf[] {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return block.children.flatMap(inlineLeaves);
    case "headed":
      return [...block.heading.children.flatMap(inlineLeaves), ...block.body.flatMap(blockLeaves)];
    case "code":
    case "tag":
      return [block.leaf];
    case "list":
      return block.items.flatMap((item) => item.blocks.flatMap(blockLeaves));
    case "quote":
      return block.children.flatMap(blockLeaves);
    case "table":
      return block.rows.flatMap((row) => row.flatMap((cell) => cell.flatMap(inlineLeaves)));
    case "rule":
      return [];
    case "section":
      return [block.open, ...block.body.flatMap(blockLeaves), block.close];
    case "region":
      return blockLeaves(block.body);
  }
}
function inlineLeaves(inline: Inline): Leaf[] {
  switch (inline.kind) {
    case "text":
    case "code":
    case "html":
      return [inline.leaf];
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
      return inline.children.flatMap(inlineLeaves);
    case "break":
      return [];
  }
}

// The characters of each passage of a rendering.
const passages = ({ text, passages }: Rendering) => passages.map(({ start, end }) => text.slice(start, end));
// The blocks of a Markdown text.
const blocksOf = (text: string) => (render(text, "markdown").runs[0] as Extract<Run, { kind: "markdown" }>).blocks;

const lines = (count: number, indent = "") => Array.from({ length: count }, (_, index) => `${indent}line ${index}\n`).join("");

const corpus = [
  "# Title\n\nSome *emphasis*, **strong**, ~~gone~~ and `code`.\n",
  "- one\n- two\n  1. nested\n  2. more\n\n> quoted **bold**\n> - in a list\n",
  "| a | b |\n|:--|--:|\n| 1 | 2 |\n| x | `y` |\n",
  "- [ ] todo\n- [x] done\n- [X]\tdone too\n- [ ]not a box\n",
  "Escapes \\*not emphasis\\* &amp; entities &copy;, a [link](https://example.com) and ![alt](https://example.com/img.png).\n",
  "A [reference][r].\n\n[r]: https://example.com/r\n",
  "Hard  \nbreak, soft\nbreak.\n\n---\n\n<div>\nhtml block\n</div>\n\n<command-name>/clear</command-name>\n",
  "```ts\nconst a = 1;\n```\n\nafter\n",
  "before\n```py\n" + lines(LONG) + "```\nafter\n",
  "<system-reminder>\n**reminded**\n" + lines(LONG) + "</system-reminder>\nafter *that*\n",
  "1. Run:\n   ```sh\n" + lines(LONG, "   ") + "   ```\n2. Then.\n",
  "- a\n  <example>\n  inside\n  </example>\n- b\n",
  "intro\n\n# One\n\nalpha\n\n## Deep\n\nbeta\n\n### Deeper\n\n## Next\n\ngamma\n\n# Two\n",
];

describe("render", () => {
  it("draws its text as its leaves, one after another, each passage a run of them", () => {
    for (const text of corpus) {
      for (const form of ["markdown", "verbatim"] as const) {
        const rendering = render(text, form);
        const all = leaves(rendering.runs);
        expect(all.map((leaf) => leaf.text).join("")).toBe(rendering.text);
        for (const leaf of all) expect(rendering.text.slice(leaf.start, leaf.start + leaf.text.length)).toBe(leaf.text);
        expect(passages(rendering).join("")).toBe(rendering.text);
      }
    }
  });

  it("shows a Markdown text as a reader reads it, its syntax drawn by no leaf, each block a passage", () => {
    expect(passages(render(corpus[0]!, "markdown"))).toEqual(["Title", "Some emphasis, strong, gone and code."]);
    expect(render(corpus[4]!, "markdown").text).toBe("Escapes *not emphasis* & entities ©, a link and alt.");
    expect(blocksOf(corpus[5]!)).toMatchObject([{ kind: "paragraph", children: [{}, { kind: "link", url: "https://example.com/r" }, {}] }]);
    expect(passages(render(corpus[6]!, "markdown"))).toEqual(["Hard", "break, soft\nbreak.", "<div>", "html block", "</div>", "<command-name>/clear</command-name>"]);
  });

  it("finds a query within a passage: across emphasis, never across two blocks or cells, nor in what no leaf draws", () => {
    const rendering = render("one *two*\n\nthree\n\n| a | b |\n|---|---|\n| c | d |\n", "markdown");
    expect(find(/one two/gu, rendering)).toEqual([{ start: 0, end: 7 }]);
    expect(find(/twothree|\n|\t|ab/gu, rendering)).toEqual([]);
  });

  it("shows a verbatim text as it came", () => {
    for (const text of corpus) expect(render(text, "verbatim").text).toBe(text);
  });

  it("reads a list, a task list, a table and a quote into their blocks", () => {
    expect(blocksOf(corpus[1]!)).toMatchObject([{ kind: "list", ordered: false, items: [{}, { blocks: [{ kind: "paragraph" }, { kind: "list", ordered: true, start: 1 }] }] }, { kind: "quote" }]);
    expect(blocksOf(corpus[3]!)).toMatchObject([{ kind: "list", items: [{ checked: false }, { checked: true }, { checked: true }, { checked: undefined }] }]);
    expect(passages(render(corpus[3]!, "markdown"))).toEqual(["todo", "done", "done too", "[ ]not a box"]);
    const [table] = blocksOf(corpus[2]!);
    expect(table).toMatchObject({ kind: "table", align: ["left", "right"] });
    expect((table as Extract<Block, { kind: "table" }>).rows.map((row) => row.length)).toEqual([2, 2, 2]);
  });

  it("shows an image as a link to it, by its description read as Markdown, or its URL when it has none", () => {
    expect(render("![**b**](https://x/y.png) ![](https://x/café.png)\n", "markdown").text).toBe("b https://x/café.png");
    expect(blocksOf("![**b**](https://x/y.png)\n")).toMatchObject([{ kind: "paragraph", children: [{ kind: "link", url: "https://x/y.png", children: [{ kind: "strong" }] }] }]);
  });

  it("draws an image inside a link, a badge, by its description, opening the link around it", () => {
    expect(blocksOf("[![b](https://x/img.png)](https://y)\n")).toMatchObject([{ kind: "paragraph", children: [{ kind: "link", url: "https://y", children: [{ kind: "text", leaf: { text: "b" } }] }] }]);
    expect(blocksOf("[*![b](https://x/img.png)*](https://y)\n")).toMatchObject([{ kind: "paragraph", children: [{ kind: "link", children: [{ kind: "emphasis", children: [{ kind: "text" }] }] }] }]);
  });

  it("links only to a web page: a link or an image by any other scheme shows as its text", () => {
    const rendering = render("[docs](ms-msdt:x) [file](file:///etc/passwd) [js](javascript:alert(1)) [here](#top) ![pic](img.png) [web](https://example.com)\n", "markdown");
    expect(rendering.text).toBe("docs file js here pic web");
    const [paragraph] = blocksOf("[docs](ms-msdt:x) [web](https://example.com)\n");
    expect(paragraph).toMatchObject({ children: [{ kind: "text" }, { kind: "text" }, { kind: "link", url: "https://example.com" }] });
  });

  it("shows a short code block in its text, and folds a long one where it stands, by the lines it spans, fences and all, as a verbatim text does", () => {
    expect(blocksOf(corpus[7]!)).toMatchObject([{ kind: "code", leaf: { text: "const a = 1;" } }, { kind: "paragraph" }]);
    const rendering = render(corpus[8]!, "markdown");
    expect(blocksOf(corpus[8]!)).toMatchObject([{ kind: "paragraph" }, { kind: "region", line: 1, label: "```py", lines: LONG + 2, body: { kind: "code" } }, { kind: "paragraph" }]);
    expect(render(corpus[8]!, "verbatim").runs.find((run) => run.kind === "region")).toMatchObject({ line: 1, lines: LONG + 2 });
    expect(blocksOf(corpus[8]!.replace("```py", "```  py ")).find((block) => block.kind === "region")).toMatchObject({ label: "```py" });
    expect(regionsAround(rendering, rendering.text.indexOf("line 3"))).toEqual([1]);
    expect(regionsAround(rendering, rendering.text.indexOf("after"))).toEqual([]);
  });

  it("keeps a long code block inside the list item holding it, its list whole", () => {
    expect(blocksOf(corpus[10]!)).toMatchObject([{ kind: "list", ordered: true, items: [{ blocks: [{ kind: "paragraph" }, { kind: "region", line: 1, label: "```sh" }] }, {}] }]);
  });

  it("reads a tagged section's body as Markdown, in the container holding its tags, and folds a long one", () => {
    expect(blocksOf(corpus[11]!)).toMatchObject([{ kind: "list", items: [{ blocks: [{ kind: "paragraph" }, { kind: "section", open: { text: "<example>" }, body: [{ kind: "paragraph" }], close: { text: "</example>" } }] }, {}] }]);
    const rendering = render(corpus[9]!, "markdown");
    expect(blocksOf(corpus[9]!)).toMatchObject([{ kind: "region", line: 0, label: "<system-reminder>", lines: LONG + 3, body: { kind: "section", body: [{ kind: "paragraph" }] } }, { kind: "paragraph" }]);
    // The opening and closing lines are the region's too; what follows is in none.
    for (const inside of ["<system-reminder>", "reminded", "</system-reminder>"]) expect(regionsAround(rendering, rendering.text.indexOf(inside))).toEqual([0]);
    expect(regionsAround(rendering, rendering.text.indexOf("that"))).toEqual([]);
  });

  it("holds under a heading what stands up to the next heading of its depth or a shallower one, the sections of deeper headings among it", () => {
    expect(blocksOf(corpus[0]!)).toMatchObject([{ kind: "headed", lines: 2, heading: { depth: 1, line: 0 }, body: [{ kind: "paragraph" }] }]);
    // What stands before the first heading is in no section, and a heading nothing stands under is a heading alone.
    expect(blocksOf(corpus[12]!)).toEqual([
      { kind: "paragraph", children: [expect.anything()] },
      {
        kind: "headed",
        lines: 12,
        heading: expect.objectContaining({ depth: 1, line: 2 }),
        body: [
          expect.objectContaining({ kind: "paragraph" }),
          { kind: "headed", lines: 4, heading: expect.objectContaining({ depth: 2, line: 6 }), body: [expect.objectContaining({ kind: "paragraph" }), expect.objectContaining({ kind: "heading", depth: 3 })] },
          { kind: "headed", lines: 2, heading: expect.objectContaining({ depth: 2, line: 12 }), body: [expect.objectContaining({ kind: "paragraph" })] },
        ],
      },
      expect.objectContaining({ kind: "heading", depth: 1 }),
    ]);
  });

  it("folds what stands under a heading, not the heading: a place under it is in its section and those around it, outermost first", () => {
    const rendering = render(corpus[12]!, "markdown");
    const around = (word: string) => regionsAround(rendering, rendering.text.indexOf(word));
    expect(["intro", "One", "alpha", "Deep", "beta", "Deeper", "Next", "gamma", "Two"].map(around)).toEqual([[], [], [2], [2], [2, 6], [2, 6], [2], [2, 12], []]);
    // A long code block alone under a heading is the section's characters and its own: the section is around it.
    const code = render("# Code\n```py\n" + lines(LONG) + "```\n", "markdown");
    expect(regionsAround(code, code.text.indexOf("line 3"))).toEqual([0, 1]);
  });

  it("ends a heading's section where the container holding it does, a tagged section or a quote, each whole under the heading before it", () => {
    expect(blocksOf("# Rules\n\n<notes>\n## Inside\n\nx\n</notes>\n\nafter\n")).toMatchObject([
      { kind: "headed", heading: { line: 0 }, body: [{ kind: "section", body: [{ kind: "headed", heading: { line: 3 }, body: [{ kind: "paragraph" }] }] }, { kind: "paragraph" }] },
    ]);
    expect(blocksOf("# Rules\n\n> ## Quoted\n> x\n\nafter\n")).toMatchObject([
      { kind: "headed", heading: { line: 0 }, body: [{ kind: "quote", children: [{ kind: "headed", heading: { line: 2 }, body: [{ kind: "paragraph" }] }] }, { kind: "paragraph" }] },
    ]);
  });

  it("closes a section at the last of its name still open, leaves a tag nothing closes as a tag line, and reads a tag in a code block as code", () => {
    expect(blocksOf("<a>\n<b>\nx\n</a>\n</c>\n")).toMatchObject([{ kind: "section", body: [{ kind: "tag", leaf: { text: "<b>" } }, { kind: "paragraph" }] }, { kind: "tag", leaf: { text: "</c>" } }]);
    expect(blocksOf("<a>\n<a>\nx\n</a>\ny\n</a>\n")).toMatchObject([{ kind: "section", body: [{ kind: "section" }, { kind: "paragraph" }] }]);
    expect(blocksOf("<open>\nnever closed\n")).toMatchObject([{ kind: "tag" }, { kind: "paragraph" }]);
    expect(blocksOf("```xml\n<a>\n```\n</a>\n")).toMatchObject([{ kind: "code", leaf: { text: "<a>" } }, { kind: "tag" }]);
  });

  it("renders a text once in a form, whichever part holds it, as a resent prompt or a reply's text remade by each event is", () => {
    const part = (form: "markdown" | "verbatim") => ({ kind: "text" as const, form, text: "# Rules\n**be brief**\n" });
    expect(renderingOf(part("markdown"))).toBe(renderingOf(part("markdown")));
    expect(renderingOf(part("verbatim")).text).toBe("# Rules\n**be brief**\n");
  });

  it("opens a section only at a line holding its tag alone, never a self-closing one, in either form", () => {
    for (const text of [`<example>Some text\n${lines(LONG + 1)}</example>\n`, `<item />\n${lines(LONG + 1)}</item>\n`]) {
      expect(render(text, "verbatim").folds).toEqual([]);
      expect(render(text, "markdown").folds).toEqual([]);
    }
    expect(render(`  <example>  \n${lines(LONG + 1)}</example>\n`, "verbatim").folds).toMatchObject([{ line: 0 }]);
  });

  it("names the regions around a place in a verbatim text, outermost first, a passage ending at each region's edges", () => {
    const text = "before\n<analysis>\n```py\n" + lines(LONG) + "```\n</analysis>\nafter\n";
    const rendering = render(text, "verbatim");
    expect(regionsAround(rendering, rendering.text.indexOf("line 3"))).toEqual([1, 2]);
    expect(regionsAround(rendering, 0)).toEqual([]);
    const code = text.slice(text.indexOf("```"), text.indexOf("</analysis>"));
    expect(passages(rendering)).toEqual(["before\n", "<analysis>\n", code, "</analysis>\n", "after\n"]);
    expect(find(/before\n<analysis>/gu, rendering)).toEqual([]);
  });
});
