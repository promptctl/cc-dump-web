import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import type { Part } from "../format/blocks.ts";
import type { FormattedExchange } from "../format/format.ts";
import { categoryVars } from "../theme/theme.ts";
import { positionAt, rowIndex } from "./position.ts";
import { regionKey, segments, type Segment } from "./regions.ts";
import { clockTime, compact, createGroupRows, createLayout, describeSize, estimateHeight, isExpanded, jsonText, preview, seconds, type Row } from "./rows.ts";
import { step, type Cause } from "./scroll.ts";
import { FilterBar } from "./FilterBar.tsx";
import { SearchBar } from "./SearchBar.tsx";
import { currentMatch, paint } from "./highlights.ts";
import { address, adjacent, createSearch, find, ordinal, partKey, patternOf, rangesIn, type Direction, type Range } from "./search.ts";
import { settings, useSettings } from "../settings.ts";
import { useView, view } from "./state.ts";
import { Toggle } from "./Toggle.tsx";

// The conversation, scrolling: each exchange's request, then its response, as rows of which only those on screen are
// mounted (docs/design/01-mvp.md, F4). `reading`: whether the read can still bring an exchange its end.
export function Conversation({ formatted, reading }: { formatted: FormattedExchange[]; reading: boolean }) {
  // The same object while no category's visibility changes, as when another tab changes only follow, so the layout
  // and its cache are kept. Fast Refresh keeps state but re-runs memos, so an edited module's layout is the one used.
  const visibility = useSettings(useShallow((state) => state.visibility));
  const groupRows = useMemo(() => createGroupRows(), []);
  const layOut = useMemo(() => createLayout(visibility, groupRows), [visibility, groupRows]);
  // The search's current match is listed whichever its category (F6), so a step to a hidden category's block shows it, and
  // the step after, which makes another current, hides it again.
  const current = useView((state) => state.search.current);
  const revealed = current?.key;
  const { rows, keys, every } = useMemo(() => layOut(formatted, revealed), [layOut, formatted, revealed]);
  const flipped = useView((state) => state.flipped);
  // The position's row, which is always mounted: a step to a match commits with that row on screen.
  const anchorKey = useView((state) => (state.position.at === "row" ? state.position.key : undefined));
  const scroller = useRef<HTMLElement>(null);
  // The UI is not built with React Compiler, so nothing memoizes the virtualizer's functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    getItemKey: keys.at,
    estimateSize: (index) => estimateHeight(rows[index]!, isExpanded(flipped, rows[index]!)),
    overscan: 10,
    // The position's row is always mounted, so it is measured: an offset into it is only where it says once its
    // height is known, and a row placed by its estimate may end before the offset does.
    rangeExtractor: (range) => {
      const anchor = anchorKey === undefined ? undefined : rowIndex(anchorKey, keys.indexOf);
      const indexes = defaultRangeExtractor(range);
      return anchor === undefined || indexes.includes(anchor) ? indexes : [anchor, ...indexes];
    },
    // [LAW:single-enforcer] The view owns the scroll position: the virtualizer measures rows and picks which mount,
    // and writes no offset, neither when told to scroll nor to keep a row in place as rows above it change.
    scrollToFn: () => {},
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  // Follow mode as the control shows it: off; on, at the end; or paused, at a place the reader scrolled to.
  const follow = useSettings((state) => state.follow);
  const atEnd = useView((state) => state.position.at === "end");
  const following = !follow ? "off" : atEnd ? "on" : "paused";
  const control = followStates[following];

  const written = useRef(0);
  // [LAW:effects-at-boundaries] Takes the step (view/scroll.ts) on what the scroller and the stores hold now, and
  // carries it out.
  const sync = (cause: Cause) => {
    const element = scroller.current!;
    const { position } = useView.getState();
    const rowsNow = {
      indexOf: keys.indexOf,
      placed: (index: number) => virtualizer.measurementsCache[index],
      rowAt: virtualizer.getVirtualItemForOffset,
    };
    const kept = { position, written: written.current };
    const next = step(cause, element.scrollTop, largest(element), kept, useSettings.getState().follow, rowsNow);
    written.current = next.written;
    if (next.position !== position) view.moveTo(next.position);
    if (next.write === undefined) return;
    element.scrollTop = next.write;
    // The browser clamps an offset past the end, so what was written is what it reads back.
    written.current = element.scrollTop;
  };
  const latest = useRef(sync);
  // A step runs whenever what it reads changes: after a render, on a scroll event, and when the scroller is resized.
  // The resize's step runs right after the layout that resized it, so a clamp is read as the view's own before any
  // commit can grow the content and make it look like a reader's scroll, and a scroller made shorter shows the new end
  // in that frame. The listeners step with the render last committed.
  useLayoutEffect(() => {
    latest.current = sync;
    sync("change");
  });
  useLayoutEffect(() => {
    const element = scroller.current!;
    const onScroll = () => latest.current("scroll");
    const resized = new ResizeObserver(() => latest.current("change"));
    element.addEventListener("scroll", onScroll, { passive: true });
    resized.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      resized.disconnect();
    };
  }, []);
  // Following, a click stops; paused or off, it follows from the end.
  const toggleFollow = () => {
    settings.setFollow(following !== "on");
    if (following !== "on") view.moveTo({ at: "end" });
    latest.current("choose");
  };
  // The search (docs/design/01-mvp.md, F6): its matches among every row, in the hidden categories as well.
  const query = useView((state) => state.search.query);
  const options = useSettings(useShallow((state) => state.search));
  const { pattern, error } = useMemo(() => patternOf(query, options), [query, options]);
  const search = useMemo(() => createSearch(), []);
  const found = useMemo(() => search(every.rows, pattern), [search, every.rows, pattern]);
  const currentOrdinal = useMemo(() => ordinal(found, current, pattern), [found, current, pattern]);
  // A step to a match, as one act: it is committed with its block and regions open and its row mounted, then the view
  // is put at the match's line, a few of its lines below the top.
  const stepTo = (direction: Direction) => {
    const next = adjacent(found, current, useView.getState().position, direction, pattern, every.keys);
    if (next === undefined) return;
    flushSync(() => view.goTo(next));
    const match = currentMatch();
    // [LAW:no-silent-failure] A step goes to a match found in a block, which the step lists if its category is hidden, so
    // it is painted once committed.
    if (match === undefined) throw new Error(`The match stepped to is not on screen: ${JSON.stringify(next.match)}`);
    const text = match.startContainer.parentElement!;
    const row = text.closest<HTMLElement>("[data-index]")!;
    const rowBox = row.getBoundingClientRect();
    // The step opened the row in this commit, which the virtualizer would see only once a resize is observed, after the
    // view had resolved the offset against the height the row had: its height is committed now.
    flushSync(() => virtualizer.resizeItem(Number(row.dataset.index), rowBox.height));
    const lead = leadLines * parseFloat(getComputedStyle(text).lineHeight);
    view.moveTo({ at: "row", key: next.match.key, offset: Math.max(0, match.getBoundingClientRect().top - rowBox.top - lead) });
    latest.current("choose");
  };

  // A click on a block or region is reading where the view is: the position becomes the place under the view, so
  // following pauses, and the line clicked stays where it is as what it opens grows or shrinks below it.
  const hold = useCallback(() => {
    view.moveTo(positionAt(scroller.current!.scrollTop, virtualizer.getVirtualItemForOffset));
    latest.current("choose");
  }, [virtualizer]);

  return (
    <>
      {/* The filter, the gutter's legend, and the search share one bar (docs/design/02-design.md, "Layout"). */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-1.5 bg-surface px-4 py-1.5 text-xs">
        <FilterBar />
        <SearchBar count={found.count} ordinal={currentOrdinal} error={error} onStep={stepTo} />
      </div>
      {/* The browser's own scroll anchoring would be a second writer of the offset. */}
      <main ref={scroller} className="flex flex-1 flex-col overflow-y-auto [overflow-anchor:none]">
        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-sm text-foreground-muted">No Messages API exchanges yet</p>
        ) : (
          <Hold.Provider value={hold}>
            <Pattern.Provider value={pattern}>
              <div className="relative shrink-0 font-mono text-xs" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <RowView row={rows[item.index]!} reading={reading} />
                  </div>
                ))}
              </div>
            </Pattern.Provider>
          </Hold.Provider>
        )}
        {/* A sticky child of the scroller, held at its bottom, and after the rows, so at the end it is below the last row
            rather than over it. */}
        <div className="pointer-events-none sticky bottom-0 mt-auto flex justify-end px-4 pt-1 pb-3">
          <Toggle
            data-follow={following}
            pressed={control.pressed}
            title={control.title}
            className="pointer-events-auto rounded-full bg-panel px-3 py-1 text-xs hover:bg-raised-hover"
            onClick={toggleFollow}
          >
            <span aria-hidden>{control.glyph}</span> {control.label}
          </Toggle>
        </div>
      </main>
    </>
  );
}

// How many of a match's lines the view starts above it once stepped to it, so the lines before it are in view.
const leadLines = 3;

// The control in each state of follow mode: whether it is pressed, its glyph, which is not read aloud, its label and its
// title.
const followStates = {
  on: { pressed: true, glyph: "●", label: "Following", title: "The view stays at the newest content. Click to stop following." },
  paused: {
    pressed: "mixed",
    glyph: "○", label: "Follow paused",
    title: "Away from the newest content. Scroll back to the end, or click, to follow again.",
  },
  off: { pressed: false, glyph: "○", label: "Follow off", title: "Click to follow the newest content." },
} as const;

// The search's pattern, for every text shown to highlight its matches with.
const Pattern = createContext<RegExp | undefined>(undefined);

// Where a text is, `at` its address in the block `blockKey`, its matches, and where the current one starts if it is
// in this text.
type Where = { blockKey: string; at: string; ranges: Range[]; current: number | undefined };

// A text's matches, found again only when the text or the pattern changes. A step renders again only the texts the
// current match leaves and enters.
function useWhere(blockKey: string, at: string, text: string): Where {
  const pattern = useContext(Pattern);
  if (pattern === undefined) throw new Error("A text is shown outside a Conversation");
  const ranges = useMemo(() => find(pattern, text), [pattern, text]);
  const current = useView(({ search: { current } }) => (current !== undefined && current.key === blockKey && current.at === at ? current.start : undefined));
  return { blockKey, at, ranges, current };
}

// A whole text, its matches highlighted.
function HighlightedText({ blockKey, at, text }: { blockKey: string; at: string; text: string }) {
  return <Highlighted slice={text} from={0} where={useWhere(blockKey, at, text)} />;
}

// A slice of a text, starting at `from` in it: whole lines, so a match, which a query of one line cannot carry past a
// line's end, is in one slice. Its matches are highlighted and the current one highlighted apart.
function Highlighted({ slice, from, where: { ranges, current } }: { slice: string; from: number; where: Where }) {
  const span = useRef<HTMLSpanElement>(null);
  const to = from + slice.length;
  // The current match if it is in this slice, so a step paints again only the slices it leaves and enters.
  const own = current !== undefined && current >= from && current < to ? current : undefined;
  // An empty slice has no text node, and no match to paint in one.
  useLayoutEffect(() => paint(span.current!.firstChild as Text, from, rangesIn(ranges, from, to), own), [from, to, ranges, own]);
  return <span ref={span}>{slice}</span>;
}

// What a block or region calls when clicked, before it flips: the view holds where it is.
const Hold = createContext<() => void>(() => {
  throw new Error("A block is shown outside a Conversation");
});

// The largest scroll offset: the one that shows the end of the conversation.
function largest(element: HTMLElement): number {
  return element.scrollHeight - element.clientHeight;
}

// Memoized: the layout keeps an unchanged exchange's rows the same objects, so only changed rows render again.
const RowView = memo(function RowView({ row, reading }: { row: Row; reading: boolean }) {
  switch (row.kind) {
    case "exchange":
      return <ExchangeLine exchange={row.exchange} reading={reading} />;
    case "group":
      return <h2 className="pt-2 pl-7 font-sans text-[11px] tracking-wider text-foreground-muted uppercase">{row.title}</h2>;
    case "block":
      return <BlockView row={row} />;
  }
});

// The exchange's line (docs/design/02-design.md, "Print what varies"): its facts in columns of fixed widths, aligned down
// the conversation, each cut with an ellipsis where a rare value outgrows its column, and how it ended. It is a band on
// the chrome's ground, so an exchange's start is seen without a line drawn. `reading`: whether the read can still bring
// this exchange its end.
function ExchangeLine({ exchange: { exchange, facts }, reading }: { exchange: FormattedExchange; reading: boolean }) {
  const { end } = exchange;
  const reason = exchange.response.head?.reason;
  return (
    <div className="mt-3 grid grid-cols-[4ch_8ch_minmax(8ch,1fr)_7ch_3ch_9ch_12ch_10ch_14ch_auto] items-baseline gap-x-4 bg-surface px-4 py-1 font-sans tabular-nums *:truncate">
      <span className="text-right text-foreground-muted">{facts.ordinal}</span>
      <time dateTime={facts.began} title={facts.began}>
        {clockTime(facts.began)}
      </time>
      {/* A request whose head was not recorded has no model to name; the line says why. */}
      {exchange.request.head === undefined ? <span className="text-foreground-muted">request not recorded</span> : <span className="font-mono" title={facts.model}>{facts.model}</span>}
      <span className="text-right">{facts.duration === undefined ? "" : seconds(facts.duration)}</span>
      {/* An HTTP error reads as one, its reason phrase on hover. */}
      <span className={facts.status !== undefined && facts.status >= 400 ? "text-error" : undefined} title={reason}>
        {facts.status}
      </span>
      <Fact label="in" count={facts.input} />
      <Fact label="cache" count={facts.cacheRead} />
      <Fact label="out" count={facts.output} />
      <span className="font-mono" title={facts.stopReason}>{facts.stopReason}</span>
      {/* How it ended: a response that began can still be cut, and one streaming has not ended. */}
      <span className={end?.outcome === "error" ? "text-error" : "text-foreground-muted"} title={end?.error}>
        {endings[end?.outcome ?? (reading ? "pending" : "unread")]}
      </span>
    </div>
  );
}

// A token count under its label; the label alone until the count is known.
function Fact({ label, count }: { label: string; count: number | undefined }) {
  return (
    <span>
      <span className="text-foreground-muted">{label}</span> {count === undefined ? "" : compact(count)}
    </span>
  );
}

// [LAW:dataflow-not-control-flow] What the line says of each way an exchange stands: nothing of one that completed,
// since its status says so, and of one still in flight; a word for the rest.
const endings = { ok: "", pending: "", unread: "no end read", error: "error", aborted: "aborted", stopped: "stopped" } as const;

// A block: collapsed, one line naming it, a preview of its content and its size; expanded, that line and all its parts.
// Clicking the line switches between them. The gutter bar in its category's color runs its whole height
// (docs/design/02-design.md, "One bold element").
function BlockView({ row }: { row: Extract<Row, { kind: "block" }> }) {
  const { key, block, size } = row;
  const open = useView((state) => isExpanded(state.flipped, row));
  const hold = useContext(Hold);
  return (
    <div className="ml-4 border-l-[3px] border-l-(--category) pr-4 pl-3" style={categoryVars(block.category)}>
      <button
        type="button"
        className="flex w-full items-baseline gap-3 text-left font-sans hover:bg-hover"
        onClick={() => {
          hold();
          view.toggle(key);
        }}
      >
        <span className="w-3 text-foreground-muted">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 truncate" title={block.name}>
          <HighlightedText blockKey={key} at={address.name} text={block.name} />
        </span>
        {/* Expanded, the content itself is below, so the line does not say it twice. */}
        <span className="min-w-0 flex-1 truncate font-mono text-foreground-muted">{open ? "" : preview(block)}</span>
        <span className="tabular-nums text-foreground-muted" title={describeSize(size)}>
          {compact(size)}
        </span>
      </button>
      {open && (
        <div className="max-w-[110ch] pb-1 pl-6">
          {block.parts.map((part, index) => (
            <PartView key={index} part={part} blockKey={key} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

// `index`: the part's place among its block's parts.
function PartView({ part, blockKey, index }: { part: Part; blockKey: string; index: number }) {
  return (
    <div className="py-0.5">
      {part.label !== undefined && <div className="text-foreground-muted">{part.label}</div>}
      <PartContent part={part} blockKey={blockKey} index={index} />
    </div>
  );
}

function PartContent({ part, blockKey, index }: { part: Part; blockKey: string; index: number }) {
  switch (part.kind) {
    case "text":
      return <TextView text={part.text} blockKey={blockKey} at={address.part(index)} />;
    case "json":
      return <JsonView part={part} blockKey={blockKey} at={address.part(index)} />;
    case "fields":
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
          {part.fields.map(([name, value], field) => (
            <div key={field} className="contents">
              <dt className="text-foreground-muted">
                <HighlightedText blockKey={blockKey} at={address.field(index, field, "name")} text={name} />
              </dt>
              <dd className="break-all whitespace-pre-wrap">
                <HighlightedText blockKey={blockKey} at={address.field(index, field, "value")} text={value} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "media": {
      const { of, source } = part;
      switch (source.type) {
        case "base64":
          return of === "image" ? (
            <img className="max-h-96" src={`data:${source.media_type};base64,${source.data}`} alt={source.media_type} />
          ) : (
            <p>
              {source.media_type}, {describeSize(source.data.length)} of base64
            </p>
          );
        case "url":
          return of === "image" ? <img className="max-h-96" src={source.url} alt={source.url} /> : <p className="break-all">{source.url}</p>;
        case "file":
          return <p>file {source.file_id}</p>;
      }
    }
  }
}

function JsonView({ part, blockKey, at }: { part: Extract<Part, { kind: "json" }>; blockKey: string; at: string }) {
  const text = jsonText(part);
  return (
    <pre className="break-all whitespace-pre-wrap">
      <HighlightedText blockKey={blockKey} at={at} text={text} />
    </pre>
  );
}

// A text with its long regions (code blocks, tagged sections), each collapsing and expanding as a block does.
function TextView({ text, blockKey, at }: { text: string; blockKey: string; at: string }) {
  const segmented = useMemo(() => segments(text), [text]);
  return <pre className="break-words whitespace-pre-wrap">{segmentViews(segmented, useWhere(blockKey, at, text))}</pre>;
}

function segmentViews(list: Segment[], where: Where): ReactNode[] {
  return list.map((segment, index) =>
    segment.kind === "text" ? <Highlighted key={index} slice={segment.text} from={segment.start} where={where} /> : <RegionView key={index} region={segment} where={where} />,
  );
}

// A long region starts collapsed: its line names it and how many lines it spans. It is kept by its part's key and the
// line it opens on.
function RegionView({ region, where }: { region: Extract<Segment, { kind: "region" }>; where: Where }) {
  const key = regionKey(partKey(where.blockKey, where.at), region.line);
  const open = useView((state) => state.flipped[key] === true);
  const hold = useContext(Hold);
  const line = (
    <button
      type="button"
      className="text-foreground-muted hover:bg-hover"
      onClick={() => {
        hold();
        view.toggle(key);
      }}
    >
      {open ? "▾" : "▸"} {region.label} · {region.lines} lines
    </button>
  );
  return open ? (
    <span>
      {line}
      {"\n"}
      <Highlighted slice={region.open} from={region.start} where={where} />
      {segmentViews(region.body, where)}
      <Highlighted slice={region.close} from={region.end - region.close.length} where={where} />
    </span>
  ) : (
    <span>
      {line}
      {"\n"}
    </span>
  );
}
