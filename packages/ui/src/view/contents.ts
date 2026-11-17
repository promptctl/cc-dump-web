import { LONG } from "./regions.ts";
import type { Block, Heading, Inline, Run } from "./rendering.ts";

// A Markdown text's table of contents (docs/design/01-mvp.md, F4): its headings, listed in one place above it, each a
// way to its section. Not a block's content, which is what the block holds.
// [LAW:one-source-of-truth] It is read from the text's rendering, so an entry is a heading the text shows, by the line
// that names its section.

// A heading as its text's contents list it: `title`, its words; `line`, the text's line it is on; `level`, how many
// headings' sections it stands in; `lines`, how many of the text's lines stand under it; and `folds`, the lines of the
// folds that show it and what stands under it once all are open, outermost first: the regions and the sections it
// stands in, and its own section.
export type Entry = { title: string; line: number; level: number; lines: number; folds: number[] };

// The key a text's contents are opened by, among the choices, by its part's key.
export const contentsKey = (partKey: string) => `contents:${partKey}`;

// Whether a text's headings stand far apart, its first and its last more than LONG lines from each other: closer, they
// are in one place already, and the text lists none.
export const farApart = (entries: Entry[]): boolean => entries.length > 0 && entries.at(-1)!.line - entries[0]!.line > LONG;

// Every heading of a text, in the order it is read, those in a quote, a list item, a tagged section and a long region
// among them.
export function contentsOf(runs: Run[]): Entry[] {
  return runs.flatMap((run) => ofRun(run, []));
}

// Where a block stands: the lines of the folds around it, outermost first, and how many headings' sections it is in.
type Around = { folds: number[]; level: number };

function ofRun(run: Run, folds: number[]): Entry[] {
  switch (run.kind) {
    case "verbatim":
      return [];
    case "markdown":
      return ofBlocks(run.blocks, { folds, level: 0 });
    case "region":
      return run.body.flatMap((inner) => ofRun(inner, [...folds, run.line]));
  }
}

function ofBlocks(blocks: Block[], around: Around): Entry[] {
  return blocks.flatMap((block) => ofBlock(block, around));
}

function ofBlock(block: Block, around: Around): Entry[] {
  switch (block.kind) {
    case "paragraph":
    case "code":
    case "table":
    case "rule":
    case "tag":
      return [];
    case "heading":
      return [entry(block, 0, around)];
    case "headed": {
      const folds = [...around.folds, block.heading.line];
      return [entry(block.heading, block.lines, { ...around, folds }), ...ofBlocks(block.body, { folds, level: around.level + 1 })];
    }
    case "list":
      return block.items.flatMap((item) => ofBlocks(item.blocks, around));
    case "quote":
      return ofBlocks(block.children, around);
    case "section":
      return ofBlocks(block.body, around);
    case "region":
      return ofBlock(block.body, { ...around, folds: [...around.folds, block.line] });
  }
}

function entry({ children, line }: Heading, lines: number, { folds, level }: Around): Entry {
  return { title: words(children), line, level, lines, folds };
}

// What a heading says, as its line reads: a line break in it is a space.
function words(inlines: Inline[]): string {
  return inlines
    .map((inline): string => {
      switch (inline.kind) {
        case "text":
        case "code":
        case "html":
          return inline.leaf.text;
        case "emphasis":
        case "strong":
        case "delete":
        case "link":
          return words(inline.children);
        case "break":
          return " ";
      }
    })
    .join("");
}
