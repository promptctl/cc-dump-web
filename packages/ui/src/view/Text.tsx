import { useContext, useMemo, type ReactNode } from "react";
import type { Part } from "../format/parts.ts";
import { contentsKey, contentsOf, farApart, type Entry } from "./contents.ts";
import { Highlighted } from "./Highlighted.tsx";
import { ToHeading, useSection, useToggle, useWhere, type Where } from "./painting.ts";
import { renderingOf, type Block, type Fold, type Heading, type Inline, type Leaf, type Run } from "./rendering.ts";
import { keyAt, partKey } from "./search.ts";

// A text part as its rendering shows it (view/rendering.ts): the one view of every text, whoever's it is. It knows
// nothing of who said it (docs/design/02-design.md, "Two voices"). Every leaf paints the search's matches; its folds
// and its contents are F4's (docs/design/01-features.md).
export function TextView({ part, blockKey, at }: { part: Extract<Part, { kind: "text" }>; blockKey: string; at: string }) {
  const rendering = renderingOf(part);
  const where = useWhere(blockKey, at, rendering);
  const contents = useMemo(() => contentsOf(rendering.runs), [rendering]);
  return (
    <div>
      {farApart(contents) && <ContentsView entries={contents} where={where} />}
      {runViews(rendering.runs, where)}
    </div>
  );
}

// [LAW:one-source-of-truth] How a line of the view says how many of its text's lines it holds: a long region's, a
// closed heading's and an entry of the contents'. One that holds none says nothing of it, as a heading nothing stands
// under does.
const holding = (lines: number) => (lines === 0 ? "" : ` · ${lines} ${lines === 1 ? "line" : "lines"}`);

// A text's contents (contents.ts): a line in the view's words, which starts closed, as a long region does, and open
// lists the text's headings, each set in under the one whose section it stands in, with how many lines stand under it.
// A click on an entry shows its heading, with what stands under it, and goes to it. The entries say the headings again
// in the view's words, so no match is painted in them: a match in a heading is the heading's alone (search.ts).
function ContentsView({ entries, where }: { entries: Entry[]; where: Where }) {
  const { open, toggle } = useToggle(contentsKey(partKey(where.blockKey, where.at)), false);
  const toHeading = useContext(ToHeading);
  return (
    <div className="flex flex-col items-start pb-1 font-sans text-[13px] leading-relaxed">
      <button type="button" className="text-foreground-muted hover:bg-hover" aria-expanded={open} onClick={toggle}>
        <span className={beside}>{open ? "▾" : "▸"}</span> contents<span className={beside}> · {entries.length} headings</span>
      </button>
      {open &&
        entries.map((entry) => (
          <button
            key={entry.line}
            type="button"
            className="text-left hover:bg-hover"
            style={{ marginLeft: `${(entry.level + 1) * 2}ch` }}
            onClick={() =>
              toHeading(
                where.blockKey,
                keyAt(where, entry.line),
                entry.folds.map((line) => keyAt(where, line)),
              )
            }
          >
            {entry.title}
            <span className={beside}>{holding(entry.lines)}</span>
          </button>
        ))}
    </div>
  );
}

function runViews(runs: Run[], where: Where): ReactNode[] {
  return runs.map((run, index) => <RunView key={index} run={run} where={where} />);
}

const verbatim = "font-mono break-words whitespace-pre-wrap";

function RunView({ run, where }: { run: Run; where: Where }) {
  switch (run.kind) {
    case "verbatim":
      return <pre className={verbatim}>{leafView(run.leaf, where)}</pre>;
    case "markdown":
      return <div className="flex flex-col gap-2 py-0.5 font-sans text-[13px] leading-relaxed">{blockViews(run.blocks, where)}</div>;
    case "region":
      return (
        <RegionView fold={run} where={where}>
          <pre className={verbatim}>{leafView(run.open, where)}</pre>
          {runViews(run.body, where)}
          <pre className={verbatim}>{leafView(run.close, where)}</pre>
        </RegionView>
      );
  }
}

function leafView(leaf: Leaf, where: Where, key?: number): ReactNode {
  return <Highlighted key={key} slice={leaf.text} from={leaf.start} where={where} />;
}

// A long region starts collapsed: its line names it and how many lines it shows, and expanded it shows `children`. It
// is kept by its part's key and the line it opens on.
function RegionView({ fold, where, children }: { fold: Fold; where: Where; children: ReactNode }) {
  const { open, toggle } = useToggle(keyAt(where, fold.line), false);
  return (
    <div>
      <button
        type="button"
        className="font-mono text-foreground-muted hover:bg-hover"
        onClick={toggle}
      >
        {open ? "▾" : "▸"} {fold.label}
        {holding(fold.lines)}
      </button>
      {open && children}
    </div>
  );
}

function blockViews(blocks: Block[], where: Where): ReactNode[] {
  return blocks.map((block, index) => <BlockView key={index} block={block} where={where} />);
}

// Each heading level by size, in the theme's own color for it, Textual's Markdown's. A heading is a line among its
// text's, so the largest is little larger than the prose.
const headings = {
  1: { size: "text-base", color: "var(--markdown-h1-color)" },
  2: { size: "text-sm", color: "var(--markdown-h2-color)" },
  3: { size: "text-[13px]", color: "var(--markdown-h3-color)" },
  4: { size: "text-[13px]", color: "var(--markdown-h4-color)" },
  5: { size: "text-[13px]", color: "var(--markdown-h5-color)" },
  6: { size: "text-[13px]", color: "var(--markdown-h6-color)" },
} as const;

const code = "font-mono text-xs break-words whitespace-pre-wrap";
const tag = "font-mono text-xs text-foreground-muted";
// What a heading's line says beside the heading: which way its section shows, and how much is under it.
const beside = "font-mono text-xs font-normal text-foreground-muted";

function headingView({ depth, line }: Heading, where: Where, children: ReactNode) {
  return (
    <p id={keyAt(where, line)} className={`font-semibold ${headings[depth].size}`} style={{ color: headings[depth].color }}>
      {children}
    </p>
  );
}

// A heading's section: the heading is its line, and a click on it hides what stands under it, or shows it again. It
// starts as its block says its sections do, and is kept as a region is, by its part's key and the line its heading is
// on. Its blocks are its text's own, set among them as they are with it open or with no heading over them.
function HeadedView({ block, where }: { block: Extract<Block, { kind: "headed" }>; where: Where }) {
  const { open, toggle } = useSection(keyAt(where, block.heading.line));
  return (
    <>
      {headingView(
        block.heading,
        where,
        <button type="button" className="text-left hover:bg-hover" aria-expanded={open} onClick={toggle}>
          <span className={beside}>{open ? "▾" : "▸"}</span> {inlineViews(block.heading.children, where)}
          {!open && <span className={beside}>{holding(block.lines)}</span>}
        </button>,
      )}
      {open && blockViews(block.body, where)}
    </>
  );
}

function BlockView({ block, where }: { block: Block; where: Where }) {
  switch (block.kind) {
    case "paragraph":
      // A line break typed in a paragraph shows as one, as it does in the terminal.
      return <p className="break-words whitespace-pre-wrap">{inlineViews(block.children, where)}</p>;
    case "heading":
      return headingView(block, where, inlineViews(block.children, where));
    case "headed":
      return <HeadedView block={block} where={where} />;
    case "code":
      return <pre className={code}>{leafView(block.leaf, where)}</pre>;
    case "rule":
      return <hr className="border-border" />;
    case "quote":
      return <blockquote className="flex flex-col gap-2 border-l-2 border-border pl-3 text-foreground-muted">{blockViews(block.children, where)}</blockquote>;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className="pl-1">
          {/* A task's box is the view's, drawn beside its text, not in it. */}
          {item.checked !== undefined && <span className="mr-1.5 font-mono">{item.checked ? "☑" : "☐"}</span>}
          <div className={item.checked === undefined ? "flex flex-col gap-1" : "inline-flex flex-col gap-1"}>{blockViews(item.blocks, where)}</div>
        </li>
      ));
      return block.ordered ? (
        <ol className="flex list-decimal flex-col gap-1 pl-6" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-6">{items}</ul>
      );
    }
    case "table":
      return (
        <table className="w-max max-w-full border-collapse">
          <tbody>
            {block.rows.map((row, index) => (
              <tr key={index} className={index === 0 ? "border-b border-border font-semibold" : "border-b border-border/50"}>
                {row.map((cell, column) => (
                  <td key={column} className="px-2 py-0.5 align-top" style={{ textAlign: block.align[column] ?? "left" }}>
                    {inlineViews(cell, where)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "tag":
      return <p className={tag}>{leafView(block.leaf, where)}</p>;
    case "section":
      return (
        <div className="flex flex-col gap-2">
          <p className={tag}>{leafView(block.open, where)}</p>
          {blockViews(block.body, where)}
          <p className={tag}>{leafView(block.close, where)}</p>
        </div>
      );
    case "region":
      return (
        <RegionView fold={block} where={where}>
          <BlockView block={block.body} where={where} />
        </RegionView>
      );
  }
}

function inlineViews(inlines: Inline[], where: Where): ReactNode[] {
  return inlines.map((inline, index) => inlineView(inline, where, index));
}

function inlineView(inline: Inline, where: Where, key: number): ReactNode {
  switch (inline.kind) {
    case "text":
      return leafView(inline.leaf, where, key);
    case "code":
      return (
        <code key={key} className="rounded-sm bg-surface px-1 font-mono text-xs">
          {leafView(inline.leaf, where)}
        </code>
      );
    case "html":
      return (
        <code key={key} className={tag}>
          {leafView(inline.leaf, where)}
        </code>
      );
    case "emphasis":
      return <em key={key}>{inlineViews(inline.children, where)}</em>;
    case "strong":
      return <strong key={key}>{inlineViews(inline.children, where)}</strong>;
    case "delete":
      return <del key={key}>{inlineViews(inline.children, where)}</del>;
    case "link":
      // A click on a link opens it alone: it is no click on a heading the link stands in.
      return (
        <a
          key={key}
          className="underline"
          style={{ color: "var(--link-color)" }}
          href={inline.url}
          target="_blank"
          rel="noreferrer noopener"
          title={inline.url}
          onClick={(event) => event.stopPropagation()}
        >
          {inlineViews(inline.children, where)}
        </a>
      );
    case "break":
      return <br key={key} />;
  }
}
