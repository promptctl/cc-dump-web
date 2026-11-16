import { useContext, useMemo, type ReactNode } from "react";
import type { Part } from "../format/blocks.ts";
import { Highlighted } from "./Highlighted.tsx";
import { Hold, useWhere, type Where } from "./painting.ts";
import { regionKey } from "./regions.ts";
import { render, type Block, type Fold, type Inline, type Leaf, type Run } from "./rendering.ts";
import { partKey } from "./search.ts";
import { useView, view } from "./state.ts";

// A text part as its rendering shows it (view/rendering.ts): the one view of every text, whoever's it is. It knows
// nothing of who said it: the block's line names that and its gutter colors it (docs/design/02-design.md, "Two voices").
// A Markdown text's prose is set in the sans, its code and tags in the mono; a verbatim text is all mono, as it came.
// Its long regions collapse and expand as a block does (docs/design/01-mvp.md, F4), and every leaf paints the search's
// matches.
// [LAW:one-source-of-truth] A rendering is a function of the text and its form, so it is kept by them: a streamed reply's
// parts are made again with every event, its finished texts among them, which are rendered once.
export function TextView({ part: { text, form }, blockKey, at }: { part: Extract<Part, { kind: "text" }>; blockKey: string; at: string }) {
  const rendering = useMemo(() => render(text, form), [text, form]);
  return <div>{runViews(rendering.runs, useWhere(blockKey, at, rendering))}</div>;
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
  const key = regionKey(partKey(where.blockKey, where.at), fold.line);
  const open = useView((state) => state.flipped[key] === true);
  const hold = useContext(Hold);
  return (
    <div>
      <button
        type="button"
        className="font-mono text-foreground-muted hover:bg-hover"
        onClick={() => {
          hold();
          view.toggle(key);
        }}
      >
        {open ? "▾" : "▸"} {fold.label} · {fold.lines} lines
      </button>
      {open && children}
    </div>
  );
}

function blockViews(blocks: Block[], where: Where): ReactNode[] {
  return blocks.map((block, index) => <BlockView key={index} block={block} where={where} />);
}

// Each heading level by size, in the theme's own color for it, Textual's Markdown's.
const headings = {
  1: { size: "text-lg", color: "var(--markdown-h1-color)" },
  2: { size: "text-base", color: "var(--markdown-h2-color)" },
  3: { size: "text-[13px]", color: "var(--markdown-h3-color)" },
  4: { size: "text-[13px]", color: "var(--markdown-h4-color)" },
  5: { size: "text-[13px]", color: "var(--markdown-h5-color)" },
  6: { size: "text-[13px]", color: "var(--markdown-h6-color)" },
} as const;

const code = "font-mono text-xs break-words whitespace-pre-wrap";
const tag = "font-mono text-xs text-foreground-muted";

function BlockView({ block, where }: { block: Block; where: Where }) {
  switch (block.kind) {
    case "paragraph":
      // A line break typed in a paragraph shows as one, as it does in the terminal.
      return <p className="break-words whitespace-pre-wrap">{inlineViews(block.children, where)}</p>;
    case "heading":
      return (
        <p className={`font-semibold ${headings[block.depth].size}`} style={{ color: headings[block.depth].color }}>
          {inlineViews(block.children, where)}
        </p>
      );
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
      return (
        <a key={key} className="underline" style={{ color: "var(--link-color)" }} href={inline.url} target="_blank" rel="noreferrer noopener" title={inline.url}>
          {inlineViews(inline.children, where)}
        </a>
      );
    case "break":
      return <br key={key} />;
  }
}
