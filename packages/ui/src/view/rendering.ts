import MarkdownIt, { type StateBlock, type StateCore, type Token } from "markdown-it";
import type { Form, Part } from "../format/parts.ts";
import type { Range } from "./range.ts";
import { LONG, segments, tagLine, type Segment } from "./regions.ts";
import { linkOpening } from "./terminalLink.ts";

// What a text part shows (docs/design/02-design.md, "Two voices"), read as its form says: verbatim, its long regions
// cut from its lines (view/regions.ts), or as Markdown, rendered as a reader reads it, in GitHub's flavor of CommonMark,
// which the model writes in. Its long regions fold (docs/design/01-mvp.md, F4).
// [LAW:one-source-of-truth] One rendering, a function of the text and its form alone, is both what the view draws and
// what the search reads: `text`, the characters the rendering shows, in order, as the DOM's textContent holds them, and
// the leaves that draw them, each placed at its offset in `text`. So a match the search counts is one the reader sees, the syntax a Markdown
// text is written in matches nothing, and a match is painted where it is with no mapping back to the source.

// Characters drawn as one run of one text node, starting at `start` in the rendering's text.
export type Leaf = { text: string; start: number };

// A link's URL is a web page's: one by any other scheme would open an app on the reader's machine, so its text shows
// alone.
export type Inline =
  | { kind: "text" | "code" | "html"; leaf: Leaf }
  | { kind: "emphasis" | "strong" | "delete"; children: Inline[] }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "break" };

export type Align = "left" | "right" | "center" | null;

// A tagged section, as a prompt wraps a reminder or a CLAUDE.md's rules: a line holding only an opening tag, the blocks
// up to the line holding only its closing tag, in the same container, and that line. A tag line neither is is a `tag`.
// A long code block or section is a region, folded where it stands, `lines` the lines it shows.
export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: "code"; leaf: Leaf }
  | { kind: "list"; ordered: boolean; start: number | undefined; items: Item[] }
  | { kind: "quote"; children: Block[] }
  | { kind: "table"; align: Align[]; rows: Inline[][][] }
  | { kind: "rule" }
  | { kind: "tag"; leaf: Leaf }
  | { kind: "section"; open: Leaf; body: Block[]; close: Leaf }
  | ({ kind: "region"; body: Block } & Fold);

// A list item: its blocks, and, in a task list, whether its box is checked.
export type Item = { checked: boolean | undefined; blocks: Block[] };

// A long region: `line`, the text's line it opens on, which names it, its label, and how many of the text's lines it
// spans, its opening and closing lines among them, as a verbatim text's region counts them (view/regions.ts).
export type Fold = { line: number; label: string; lines: number };

// A run of a text: a verbatim leaf, Markdown's blocks, or a verbatim text's long region, its opening and closing lines
// and its body runs of its own.
export type Run = { kind: "verbatim"; leaf: Leaf } | { kind: "markdown"; blocks: Block[] } | ({ kind: "region"; open: Leaf; body: Run[]; close: Leaf } & Fold);

// A text that folds: its characters, the passages of them a query matches within, and each fold's characters, named by
// a line, outermost first.
export type Folded = { text: string; passages: Range[]; folds: (Range & { line: number })[] };

// `passages`: the stretches of `text` a query matches within, in order, each leaves drawn one after another; a block,
// a cell, the lines either side of a hard break and a region each end one, so a match runs across no two things a
// reader sees apart, and into no region from outside it. `folds`: each region's line and characters, outermost first.
export type Rendering = Folded & { runs: Run[] };

type TextPart = Extract<Part, { kind: "text" }>;

// [LAW:one-source-of-truth] One rendering of a text in a form, however many parts hold it: Claude Code resends the
// prompt and every message with each request, and a streamed reply's parts are made again with each event, so a text is
// rendered when it is first seen. A part holding a text keeps its rendering; a text no part holds any longer is
// forgotten with it. [LAW:no-shared-mutable-globals] `renderingOf` is the caches' one reader and writer.
const byPart = new WeakMap<TextPart, Rendering>();
const byText: Record<Form, Map<string, WeakRef<Rendering>>> = { markdown: new Map(), verbatim: new Map() };
// A text's entry goes once its rendering is collected, unless the text has been rendered again since.
const forgotten = new FinalizationRegistry<{ text: string; form: Form }>(({ text, form }) => {
  if (byText[form].get(text)?.deref() === undefined) byText[form].delete(text);
});

export function renderingOf(part: TextPart): Rendering {
  const rendering = byPart.get(part) ?? byText[part.form].get(part.text)?.deref() ?? remembered(part);
  byPart.set(part, rendering);
  return rendering;
}

function remembered({ text, form }: TextPart): Rendering {
  const rendering = render(text, form);
  byText[form].set(text, new WeakRef(rendering));
  forgotten.register(rendering, { text, form });
  return rendering;
}

// `text` as it shows in `form`. [LAW:dataflow-not-control-flow] The form is the one thing that varies how it is read.
export function render(text: string, form: Form): Rendering {
  const writer = createWriter();
  const runs: Run[] = form === "verbatim" ? verbatim(segments(text), writer) : [{ kind: "markdown", blocks: markdown(text, writer) }];
  return { ...writer.done(), runs };
}

// The lines of the folds holding offset `at` of a text, outermost first.
export function regionsAround({ folds }: Folded, at: number): number[] {
  return folds.filter(({ start, end }) => start <= at && at < end).map(({ line }) => line);
}

// The rendering's text, written as its leaves are made, in order: `cut` ends a passage, and `fold` places the region
// opening on `line` on its characters, already written, a passage ending on each side of them.
type Writer = {
  leaf: (text: string) => Leaf;
  cut: () => void;
  at: () => number;
  fold: (line: number, characters: Range) => void;
  done: () => Omit<Rendering, "runs">;
};

function createWriter(): Writer {
  const written: string[] = [];
  const passages: Range[] = [];
  const folds: Rendering["folds"] = [];
  let length = 0;
  let passage = 0;
  const cut = () => {
    if (length > passage) passages.push({ start: passage, end: length });
    passage = length;
  };
  return {
    leaf: (text) => {
      const leaf = { text, start: length };
      written.push(text);
      length += text.length;
      return leaf;
    },
    cut,
    at: () => length,
    fold: (line, characters) => folds.push({ line, ...characters }),
    // A region is placed once whole, so one inside another is placed first; outermost first is by where each starts.
    done: () => {
      cut();
      return { text: written.join(""), passages, folds: folds.sort((a, b) => a.start - b.start || b.end - a.end) };
    },
  };
}

// A verbatim text's segments: each run of text a leaf, each long region its lines, its body runs of its own between.
function verbatim(list: Segment[], writer: Writer): Run[] {
  return list.map((segment): Run => {
    switch (segment.kind) {
      case "text":
        return { kind: "verbatim", leaf: writer.leaf(segment.text) };
      case "region": {
        const { line, label, lines } = segment;
        writer.cut();
        const start = writer.at();
        const run: Run = { kind: "region", line, label, lines, open: writer.leaf(segment.open), body: verbatim(segment.body, writer), close: writer.leaf(segment.close) };
        writer.cut();
        writer.fold(line, { start, end: writer.at() });
        return run;
      }
    }
  });
}

// A tag line as a block of its own, at the start of a block in any container, as a fence is: never inside a code block,
// and interrupting a paragraph, so what it wraps reads as the Markdown it is.
function tag(state: StateBlock, line: number, _end: number, silent: boolean): boolean {
  if (state.sCount[line]! - state.blkIndent >= 4) return false;
  const text = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]).trimEnd();
  const found = tagLine.exec(text);
  if (found === null) return false;
  if (silent) return true;
  const token = state.push("tag", "", 0);
  token.content = text;
  token.map = [line, line + 1];
  token.meta = { name: found[2], closing: found[1] !== undefined };
  state.line = line + 1;
  return true;
}

// A task list's box, as GitHub reads it: an item whose text starts with one, then whitespace or nothing. The box is the
// item's, not its text's.
function tasks(state: StateCore): void {
  state.tokens.forEach((token, index) => {
    const inline = token.type === "list_item_open" && state.tokens[index + 1]?.type === "paragraph_open" ? state.tokens[index + 2] : undefined;
    const first = inline?.children?.[0];
    const box = first?.type === "text" ? /^\[([ xX])\](?:\s+|$)/.exec(first.content) : null;
    if (box === null || first === undefined) return;
    token.meta = { checked: box[1] !== " " };
    first.content = first.content.slice(box[0].length);
  });
}

// GitHub's flavor, as markdown-it reads it: tables, strikethrough, a URL written with its scheme as a link, and inline HTML drawn as the
// tags it is, never as HTML; a tag line a block of its own, not the start of an HTML block, which would hold the
// headings and paragraphs it wraps raw up to the next blank line. markdown-it is pinned (package.json), so the tokens its
// rules give are the ones read below; one a new version adds throws there, in the tests, not in a reader's view.
const parser = new MarkdownIt({ html: true, linkify: true }).disable("html_block");
parser.block.ruler.before("html_block", "tag", tag, { alt: ["paragraph", "reference", "blockquote"] });
parser.core.ruler.after("text_join", "tasks", tasks);
// [LAW:single-enforcer] Which URL a link may open is `linked`'s to say, below: markdown-it's own check would leave a link
// it refuses showing as its Markdown.
parser.validateLink = () => true;

// [LAW:parse-dont-validate] Markdown parsed once into blocks the view draws, each holding its leaves.
function markdown(text: string, writer: Writer): Block[] {
  return blocks(parser.parse(text, {}).values(), writer, undefined);
}

// A token stream markdown-it gives, read in order: a container is its opening token, what it holds, and its closing
// token.
type Reader = ArrayIterator<Token>;

// A tag line as read, before the sections are found: its name, whether it closes, and its line in the text.
type TagLine = { kind: "tagLine"; leaf: Leaf; name: string; closing: boolean; line: number };

// The blocks of a container, up to the token closing it, `close`, which is read too; the text's end closes the text.
function blocks(reader: Reader, writer: Writer, close: string | undefined): Block[] {
  const read: (Block | TagLine)[] = [];
  for (let token = reader.next().value; token !== undefined && token.type !== close; token = reader.next().value) {
    read.push(block(token, reader, writer));
    // Each block ends a passage, so a query never runs from one into the next.
    writer.cut();
  }
  return sections(read, writer);
}

// A container's blocks with its sections found: a closing tag line closes the last section of its name still open, so
// a section quoting another of its name closes at its own, and one opened inside it and left open is a tag line in it.
function sections(read: (Block | TagLine)[], writer: Writer): Block[] {
  // The sections still open, innermost last, under the container itself, each with the blocks it holds so far.
  type Open = { tag: TagLine | undefined; body: Block[] };
  const open: Open[] = [{ tag: undefined, body: [] }];
  const whole = ({ tag, body }: Open): Block[] => (tag === undefined ? body : [{ kind: "tag", leaf: tag.leaf }, ...body]);
  for (const item of read) {
    const at = item.kind === "tagLine" && item.closing ? open.findLastIndex(({ tag }) => tag?.name === item.name) : -1;
    if (item.kind === "tagLine" && !item.closing) open.push({ tag: item, body: [] });
    else if (item.kind === "tagLine" && at === -1) open.at(-1)!.body.push({ kind: "tag", leaf: item.leaf });
    else if (item.kind === "tagLine") {
      const inner = open.splice(at + 1).flatMap(whole);
      const { tag, body } = open.pop()!;
      const section: Block = { kind: "section", open: tag!.leaf, body: [...body, ...inner], close: item.leaf };
      const lines = item.line + 1 - tag!.line;
      const characters = { start: tag!.leaf.start, end: item.leaf.start + item.leaf.text.length };
      open.at(-1)!.body.push(lines > LONG ? region(section, { line: tag!.line, label: `<${item.name}>`, lines }, characters, writer) : section);
    } else open.at(-1)!.body.push(item);
  }
  return open.flatMap(whole);
}

// `body`, its characters written, folded as the region `fold`. Its blocks end passages on each side of it.
function region(body: Block, fold: Fold, characters: Range, writer: Writer): Block {
  writer.fold(fold.line, characters);
  return { kind: "region", body, ...fold };
}

function block(token: Token, reader: Reader, writer: Writer): Block | TagLine {
  switch (token.type) {
    case "paragraph_open":
      return { kind: "paragraph", children: inlineOf(reader, writer, "paragraph_close") };
    case "heading_open":
      return { kind: "heading", depth: Number(token.tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6, children: inlineOf(reader, writer, "heading_close") };
    case "fence": {
      // A region of more than LONG lines folds, its fences among them, as one cut from a verbatim text does.
      const [first, last] = token.map!;
      const leaf = writer.leaf(token.content.replace(/\n$/, ""));
      const fold = { line: first, label: `${token.markup}${token.info.trim()}`, lines: last - first };
      const code: Block = { kind: "code", leaf };
      return last - first > LONG ? region(code, fold, { start: leaf.start, end: leaf.start + leaf.text.length }, writer) : code;
    }
    case "code_block":
      return { kind: "code", leaf: writer.leaf(token.content.replace(/\n$/, "")) };
    case "hr":
      return { kind: "rule" };
    case "blockquote_open":
      return { kind: "quote", children: blocks(reader, writer, "blockquote_close") };
    case "bullet_list_open":
    case "ordered_list_open": {
      const ordered = token.type === "ordered_list_open";
      const close = ordered ? "ordered_list_close" : "bullet_list_close";
      const items: Item[] = [];
      for (let item = reader.next().value!; item.type !== close; item = reader.next().value!) {
        items.push({ checked: (item.meta as { checked?: boolean } | null)?.checked, blocks: blocks(reader, writer, "list_item_close") });
      }
      return { kind: "list", ordered, start: ordered ? Number(token.attrGet("start") ?? 1) : undefined, items };
    }
    case "table_open":
      return table(reader, writer);
    case "tag": {
      const { name, closing } = token.meta as { name: string; closing: boolean };
      return { kind: "tagLine", leaf: writer.leaf(token.content), name, closing, line: token.map![0] };
    }
    default:
      throw new Error(`markdown-it gave a block this rendering does not read: ${token.type}`);
  }
}

function table(reader: Reader, writer: Writer): Block {
  const align: Align[] = [];
  const rows: Inline[][][] = [];
  for (let token = reader.next().value!; token.type !== "table_close"; token = reader.next().value!) {
    if (token.type === "tr_open") rows.push([]);
    if (token.type === "th_open" || token.type === "td_open") {
      if (rows.length === 1) align.push(alignOf(token.attrGet("style") as string | null));
      rows.at(-1)!.push(inlineOf(reader, writer, token.type === "th_open" ? "th_close" : "td_close"));
      // Each cell ends a passage, as each block does.
      writer.cut();
    }
  }
  return { kind: "table", align, rows };
}

function alignOf(style: string | null): Align {
  const align = style?.match(/text-align:(\w+)/)?.[1];
  return align === "left" || align === "right" || align === "center" ? align : null;
}

// A block's inline content: its one inline token, then the token closing the block.
function inlineOf(reader: Reader, writer: Writer, close: string): Inline[] {
  const children = reader.next().value!.children ?? [];
  const closing = reader.next().value!;
  if (closing.type !== close) throw new Error(`markdown-it closed a block with ${closing.type}, not ${close}`);
  return inlines(children.values(), writer, undefined);
}

// The inline content up to the token closing its span, `close`, which is read too.
function inlines(reader: Reader, writer: Writer, close: string | undefined): Inline[] {
  const made: Inline[] = [];
  for (let token = reader.next().value; token !== undefined && token.type !== close; token = reader.next().value) made.push(...inline(token, reader, writer));
  return made;
}

const spans = { em_open: ["emphasis", "em_close"], strong_open: ["strong", "strong_close"], s_open: ["delete", "s_close"] } as const;

function inline(token: Token, reader: Reader, writer: Writer): Inline[] {
  switch (token.type) {
    // markdown-it leaves an empty text beside a run of emphasis delimiters, which draws nothing.
    case "text":
      return token.content === "" ? [] : [{ kind: "text", leaf: writer.leaf(token.content) }];
    case "softbreak":
      return [{ kind: "text", leaf: writer.leaf("\n") }];
    case "code_inline":
      return [{ kind: "code", leaf: writer.leaf(token.content) }];
    case "html_inline":
      return [{ kind: "html", leaf: writer.leaf(token.content) }];
    case "em_open":
    case "strong_open":
    case "s_open": {
      const [kind, close] = spans[token.type];
      return [{ kind, children: inlines(reader, writer, close) }];
    }
    case "link_open":
      return linked(String(token.attrGet("href")), inlines(reader, writer, "link_close"));
    // An image is never fetched: it shows as a link to it, by its description, or its URL when it has none.
    case "image": {
      const src = String(token.attrGet("src"));
      const description = inlines((token.children ?? []).values(), writer, undefined);
      return linked(src, description.length === 0 ? [{ kind: "text", leaf: writer.leaf(parser.normalizeLinkText(src)) }] : description);
    }
    case "hardbreak":
      writer.cut();
      return [{ kind: "break" }];
    default:
      throw new Error(`markdown-it gave inline content this rendering does not read: ${token.type}`);
  }
}

// A link to `url` around `children`, or, when `url` is not a web page's, the children alone. [LAW:single-enforcer] What
// a web page's URL is, is view/terminalLink.ts's to say: one the terminal opens in a tab.
// A link holds no link, as HTML's cannot: an image inside one, a badge, shows by its description, and opens the link
// around it.
function linked(url: string, children: Inline[]): Inline[] {
  return linkOpening(url) === "tab" ? [{ kind: "link", url, children: unlinked(children) }] : children;
}

function unlinked(inlines: Inline[]): Inline[] {
  return inlines.flatMap((inline) => (inline.kind === "link" ? unlinked(inline.children) : "children" in inline ? [{ ...inline, children: unlinked(inline.children) }] : [inline]));
}
