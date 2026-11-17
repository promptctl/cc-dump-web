import { defaultRangeExtractor, useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { diffOf, marks, type Edit } from "../format/diff.ts";
import { blockDiff, type DiffLine, type LineFold } from "./change.ts";
import { fieldLines, jsonText, type Part } from "../format/parts.ts";
import type { FormattedExchange } from "../format/format.ts";
import { categoryVars, type Theme } from "../theme/theme.ts";
import { Minimap } from "./Minimap.tsx";
import { createHistory, type Branch, type History } from "./history.ts";
import { inMotion } from "./motion.ts";
import { positionAt, rowIndex, type Placed, type Position } from "./position.ts";
import { blockOf, categoryOf, changeColors, clockTime, compact, countsOf, createLayout, describeSize, estimateHeight, foldKey, isGone, modelName, pastKey, pastOf, preview, seconds, sectionsStartOpen, setStartsOpen, sizeOf, startsExpanded, statusFailed, summaryOf, type BlockRow, type Event, type Row, type SetRow } from "./rows.ts";
import { readAt, step, type Cause } from "./scroll.ts";
import { FilterBar } from "./FilterBar.tsx";
import { SearchBar } from "./SearchBar.tsx";
import { currentMatch } from "./highlights.ts";
import { Highlighted, HighlightedText } from "./Highlighted.tsx";
import { Hold, Painted, Sections, useToggle, useWhere } from "./painting.ts";
import { TextView } from "./Text.tsx";
import { address, adjacent, createSearch, ordinal, patternOf, type Direction } from "./search.ts";
import { settings, useSettings } from "../settings.ts";
import { useView, view, type Moment } from "./state.ts";
import { Toggle } from "./Toggle.tsx";
import { TurnStrip } from "./TurnStrip.tsx";

// The conversation at the moment shown (docs/design/02-design.md, "Two axes"): one column, every row of it listed, of
// which only those on screen are mounted (docs/design/01-mvp.md, F4). `reading`: whether the read can still bring an
// exchange its end. `theme`: what the minimap's canvas is painted in.
export function Conversation({ formatted, reading, theme }: { formatted: FormattedExchange[]; reading: boolean; theme: Theme }) {
  // Fast Refresh keeps state but re-runs memos, so an edited module's history and layout are the ones used.
  const history = useMemo(() => createHistory(), []);
  const conversation = useMemo(() => history(formatted), [history, formatted]);
  const steps = conversation.segments.length;
  // Now's step, the latest, by its exchange: where a reader's act away from now leaves the moment.
  const now = conversation.segments.at(-1)?.formatted.exchange.trace_id;
  const moment = useView((state) => state.moment);
  const shown = stepShown(moment, conversation);
  // The same object while no category's visibility changes, as when another tab changes only follow, so the layout
  // and its cache are kept.
  const visibility = useSettings(useShallow((state) => state.visibility));
  const branches = useSettings((state) => state.branches);
  const layOut = useMemo(() => createLayout(visibility, branches), [visibility, branches]);
  // The search's current match is listed whichever its category (F6), so a step to a hidden category's block shows it, and
  // the step after, which makes another current, hides it again.
  const current = useView((state) => state.search.current);
  const revealed = current?.key;
  const opened = useView((state) => state.opened);
  const { rows, keys, every } = useMemo(() => layOut(conversation, shown, revealed, opened), [layOut, conversation, shown, revealed, opened]);
  // The position's row, which is always mounted: a step to a match commits with that row on screen.
  const anchorKey = useView((state) => (state.position.at === "row" ? state.position.key : undefined));
  const scroller = useRef<HTMLElement>(null);
  // The UI is not built with React Compiler, so nothing memoizes the virtualizer's functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    getItemKey: keys.measuredBy,
    estimateSize: (index) => estimateHeight(rows[index]!, opened, visibility),
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
  // [LAW:no-ambient-temporal-coupling] The rows' height measures this render's rows, and only then does the virtualizer
  // hold each one's extent, which the minimap draws.
  const total = virtualizer.getTotalSize();
  const extents = virtualizer.measurementsCache;
  // [LAW:locality-or-seam] A placed item as the position code reads it, by its row's key: the virtualizer keeps an item
  // by the key its height is measured by (ListedKeys), not the row's.
  const placedAt = (item: VirtualItem | undefined): Placed | undefined => item && { key: keys.at(item.index), start: item.start, size: item.size };
  // The placed row at an offset.
  const rowAt = (offset: number) => placedAt(virtualizer.getVirtualItemForOffset(offset));

  // Follow mode as the control shows it: off; on, at the end; or paused, at a place the reader scrolled to, or at a step
  // they chose in time.
  const follow = useSettings((state) => state.follow);
  const atEnd = useView((state) => state.position.at === "end");
  const chosen = useView((state) => state.moment.at === "chosen");
  const following = !follow ? "off" : atEnd ? "on" : chosen ? "chosen" : "paused";
  const control = followStates[following];

  const written = useRef(0);
  // [LAW:effects-at-boundaries] Takes the step (view/scroll.ts) on what the scroller and the stores hold now, and
  // carries it out.
  const sync = (cause: Cause) => {
    const element = scroller.current!;
    const { position, moment } = useView.getState();
    const rowsNow = {
      indexOf: keys.indexOf,
      placed: (index: number) => placedAt(virtualizer.measurementsCache[index]),
      rowAt,
    };
    const kept = { position, written: written.current };
    const next = step(cause, element.scrollTop, largest(element), kept, useSettings.getState().follow, moment.at !== "chosen", rowsNow);
    written.current = next.written;
    if (next.position !== position) view.place(next.position, next.by, now);
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
  // Following, a click stops; paused or off, it follows from the end, now, whichever moment was shown.
  const toggleFollow = () => {
    settings.setFollow(following !== "on");
    if (following !== "on") view.place({ at: "end" }, "reader", now);
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
    flushSync(() => view.goTo(next, now, visibility));
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
    view.place({ at: "row", key: next.match.key, offset: Math.max(0, match.getBoundingClientRect().top - rowBox.top - lead) }, "reader", now);
    latest.current("choose");
  };

  // A click on a block, region or fold is reading where the view is: the position becomes the place under the view, so
  // following pauses, and the line clicked stays where it is as what it opens grows or shrinks below it.
  const hold = () => {
    view.place(positionAt(scroller.current!.scrollTop, rowAt), "reader", now);
    latest.current("choose");
  };
  // The reader moving the view to `offset` from the minimap, as a scroll there would: the place there, so following
  // pauses, or the end, where following resumes.
  const placeAt = (offset: number) => {
    view.place(readAt(offset, largest(scroller.current!), useSettings.getState().follow, useView.getState().moment.at !== "chosen", rowAt), "reader", now);
    latest.current("choose");
  };

  // A move in time to step `target`: the moment becomes that step, now if it is the latest, and the view is put at the
  // step's own exchange line, where what it brought begins, or, following, at the end. What the step did to a row
  // above it is marked on the minimap. Committed first, so the position is put among the step's own rows.
  const toStep = (target: number) => {
    const latestStep = target === steps;
    const trace = conversation.segments[target - 1]!.formatted.exchange.trace_id;
    const position: Position = latestStep && useSettings.getState().follow ? { at: "end" } : { at: "row", key: trace, offset: 0 };
    flushSync(() => view.moveInTime(latestStep ? { at: "now" } : { at: "chosen", trace }, position));
    latest.current("choose");
  };
  // [LAW:no-ambient-temporal-coupling] The step the last move is going to, until its update commits: a move made while a
  // motion runs goes on from there, so three quick presses move three steps. It is cleared however the update ends. A
  // move to the step it would leave from is none. The update runs once the motion has taken the page as it was, so it
  // moves through the render last committed then, not the one pressed in.
  const aimed = useRef<number | undefined>(undefined);
  const go = (target: number) => {
    const from = aimed.current ?? shown;
    if (target === from) return;
    aimed.current = target;
    void inMotion(target < from ? "back" : "forward", () => moves.current.toStep(target)).finally(() => {
      if (aimed.current === target) aimed.current = undefined;
    });
  };
  const goBy = (by: -1 | 1) => go(Math.min(steps, Math.max(1, (aimed.current ?? shown) + by)));
  // The moves and the hold, through the render last committed, so the strip's marks and the rows, memoized, render only
  // as what they show changes.
  const moves = useRef({ go, goBy, toStep, hold, placeAt });
  useLayoutEffect(() => {
    moves.current = { go, goBy, toStep, hold, placeAt };
  });
  const onGo = useCallback((target: number) => moves.current.go(target), []);
  const onHold = useCallback(() => moves.current.hold(), []);
  const onPlace = useCallback((offset: number) => moves.current.placeAt(offset), []);
  const onStep = useCallback((by: -1 | 1) => moves.current.goBy(by), []);
  // ← and → move one step, unless a field takes the keys or what they were pressed in handled them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const by = arrows[event.key];
      if (by === undefined || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || takesKeys(event.target)) return;
      event.preventDefault();
      onStep(by);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep]);

  return (
    <>
      {/* The filter, the gutter's legend, and the search share one bar (docs/design/02-design.md, "Layout"). */}
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-1.5 bg-surface px-4 py-1.5 text-xs">
        <FilterBar />
        <SearchBar count={found.count} ordinal={currentOrdinal} error={error} onStep={stepTo} />
      </div>
      <TurnStrip segments={conversation.segments} shown={shown} onGo={onGo} onStep={onStep} />
      <div className="flex min-h-0 flex-1">
        {/* The browser's own scroll anchoring would be a second writer of the offset. The area is what a move in time
            slides (index.css). */}
        <main ref={scroller} className="flex min-w-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none] [view-transition-name:conversation]">
          {rows.length === 0 ? (
            <p className="flex flex-1 items-center justify-center text-sm text-foreground-muted">No Messages API exchanges yet</p>
          ) : (
            <Hold.Provider value={onHold}>
              <Painted.Provider value={pattern}>
                <div className="relative shrink-0 font-mono text-xs" style={{ height: total }}>
                  {virtualizer.getVirtualItems().map((item) => (
                    <ListedRow key={keys.at(item.index)} item={item} measure={virtualizer.measureElement}>
                      <RowView row={rows[item.index]!} reading={reading} />
                    </ListedRow>
                  ))}
                </div>
              </Painted.Provider>
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
        <Minimap rows={rows} extents={extents} scroller={scroller} theme={theme} onPlace={onPlace} />
      </div>
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
  // A step chosen in time ends where it ends, so scrolling there resumes nothing.
  chosen: { pressed: "mixed", glyph: "○", label: "Follow paused", title: "At an earlier step. Click, or go to the latest step, to follow again." },
  off: { pressed: false, glyph: "○", label: "Follow off", title: "Click to follow the newest content." },
} as const;

// The moment's step: the latest, now; or the step held, which, until its exchange is read, as after a reload, is as far
// as the read has come.
function stepShown(moment: Moment, { segments, stepOf }: History): number {
  return moment.at === "now" ? segments.length : (stepOf(moment.trace) ?? segments.length);
}

// The keys that move in time, and whether an element takes them for its own: a field typed or chosen in.
const arrows: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowRight: 1 };
function takesKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

// The largest scroll offset: the one that shows the end of the conversation.
function largest(element: HTMLElement): number {
  return element.scrollHeight - element.clientHeight;
}

// A row: a fold; anything else what it shows beside a band at its left edge in the color of what the step shown did to
// it, none where the step left the row as it was. The band stands where a ground would: the theme's text is promised
// legible on its muted grounds only in their own `text-` color, and the foreground fails on them in most themes.
// Memoized on what it shows, every field of the row, so a row the layout makes again as it was does not render again.
const RowView = memo(
  function RowView({ row, reading }: { row: Row; reading: boolean }) {
    if (row.kind === "fold") return <FoldLine fold={row} />;
    const band = changeColors[row.change];
    return (
      // A branch's rows stand one step in, under the thread they left (docs/design/02-design.md, "Two axes").
      <div className={`border-l-4 border-transparent ${row.branch === undefined ? "" : "pl-6"}`} style={band && { borderLeftColor: `var(${band})` }}>
        <Shown row={row} reading={reading} />
      </div>
    );
  },
  (before, after) => before.reading === after.reading && sameFields(before.row, after.row),
);

// What a row of each kind shows.
function Shown({ row, reading }: { row: Exclude<Row, { kind: "fold" }>; reading: boolean }) {
  switch (row.kind) {
    case "exchange":
      return <ExchangeLine exchange={row.exchange} branch={row.branch} reading={reading} />;
    case "group":
      return <h2 className="pt-2 pl-7 font-sans text-[11px] tracking-wider text-foreground-muted uppercase">{row.title}</h2>;
    case "set":
      return <SetLine row={row} />;
    case "block":
      return <BlockView row={row} />;
  }
}

// Whether two rows show the same: every field the same value.
function sameFields(a: Row, b: Row): boolean {
  const fields = Object.entries(a);
  return fields.length === Object.keys(b).length && fields.every(([name, value]) => (b as Record<string, unknown>)[name] === value);
}

// A set's line (rows.ts, SetRow), a heading that is a control: its title where a group's is, then how many blocks the
// set holds and their names, as many as the line has room for, the last thing a step did to one of them, in the
// foreground where the step shown did it, and their size together. A click lists the blocks under it, or takes them
// back into the line, from how the set starts.
function SetLine({ row }: { row: SetRow }) {
  const starts = useSettings((state) => setStartsOpen(categoryOf(row), state.visibility));
  const { open, toggle } = useToggle(row.key, starts);
  const { count, names, size, last, touched } = summaryOf(row);
  return (
    <div className="flex items-baseline gap-3 pt-2 pr-4 pl-2 font-sans text-foreground-muted hover:bg-hover">
      <button type="button" aria-expanded={open} className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={toggle}>
        <span className="w-3">{open ? "▾" : "▸"}</span>
        <h2 className="text-[11px] tracking-wider uppercase">{row.title}</h2>
        <span className="tabular-nums">{count}</span>
        <span className="min-w-0 flex-1 truncate" title={names.join(", ")}>
          {names.join(", ")}
        </span>
      </button>
      {last === undefined ? null : (
        <span data-past className={`shrink-0 ${row.change === "same" ? "" : "text-foreground"}`}>
          {`${last.name} ${deeds[last.event.change]} at step ${last.event.step}${touched > 1 ? ` · ${touched - 1} more` : ""}`}
        </span>
      )}
      <span className="tabular-nums" title={describeSize(size)}>
        {compact(size)}
      </span>
    </div>
  );
}

// A run of a branch's rows, folded: one line saying how many, which opens it on a click.
function FoldLine({ fold }: { fold: Extract<Row, { kind: "fold" }> }) {
  const { toggle } = useToggle(foldKey(fold.key), false);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 py-0.5 pl-7 text-left font-sans text-foreground-muted hover:bg-hover"
      onClick={toggle}
    >
      <span className="w-3">▸</span>
      {`branch off ${fold.branch.from} · ${fold.rows.length} rows`}
    </button>
  );
}

// The exchange's line (docs/design/02-design.md, "Print what varies", "Layout"): its facts in columns of fixed widths,
// aligned down the conversation, on two rows: who answered and how it ended, then the tokens. The model's column alone
// gives way to a narrow window, cut with an ellipsis, as is any rare value that outgrows its column. It is a band on the
// chrome's ground, so an exchange's start is seen without a line drawn. `reading`: whether the read can still bring this
// exchange its end. `branch`: the branch its request is on, which its model's column names first, where a long model's
// ellipsis does not reach.
function ExchangeLine({ exchange: { exchange, facts }, branch, reading }: { exchange: FormattedExchange; branch: Branch | undefined; reading: boolean }) {
  const { end } = exchange;
  const reason = exchange.response.head?.reason;
  return (
    <div className="mt-3 grid grid-cols-[4ch_8ch_minmax(8ch,1fr)_7ch_3ch_14ch] items-baseline gap-x-3 bg-surface px-4 py-1 font-sans tabular-nums *:truncate">
      <span className="text-right text-foreground-muted">{facts.ordinal}</span>
      <time dateTime={facts.began} title={facts.began}>
        {clockTime(facts.began)}
      </time>
      {/* A request whose head was not recorded has no model to name; the line says why. */}
      {exchange.request.head === undefined ? (
        <span className="text-foreground-muted">request not recorded</span>
      ) : (
        <span className="font-mono" title={facts.model}>
          {branch === undefined ? null : (
            <span className="font-sans text-foreground-muted" title={`On a branch off step ${branch.from}: its blocks are its own, not the thread's`}>
              ↳ off {branch.from}{" "}
            </span>
          )}
          {facts.model === undefined ? null : modelName(facts.model)}
        </span>
      )}
      <span className="text-right">{facts.duration === undefined ? "" : seconds(facts.duration)}</span>
      {/* An HTTP error reads as one, its reason phrase on hover. */}
      <span className={statusFailed(facts.status) ? "text-error" : undefined} title={reason}>
        {facts.status}
      </span>
      {/* How it ended: a response that began can still be cut, and one streaming has not ended, which leads, so an
          ellipsis never takes it; then why the model stopped. */}
      <span>
        <span className={end?.outcome === "error" ? "text-error" : "text-foreground-muted"} title={end?.error}>
          {endings[end?.outcome ?? (reading ? "pending" : "unread")]}
        </span>{" "}
        <span className="font-mono" title={facts.stopReason}>{facts.stopReason}</span>
      </span>
      <div className="col-[1/-1] grid grid-cols-[9ch_12ch_14ch_10ch] gap-x-3 *:truncate">
        {countsOf(facts).map(([label, count]) => (
          <Fact key={label} label={label} count={count} />
        ))}
      </div>
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

// A listed row, where the virtualizer places it. Its element is the row's, whatever key its height is kept by
// (ListedKeys), so a click that opens it keeps focus; the virtualizer measures an element as it mounts, so the row is
// measured again whenever that key changes, its height kept by the new key even where it did not change.
function ListedRow({ item, measure, children }: { item: VirtualItem; measure: (element: HTMLElement | null) => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    measure(element.current);
    // As a ref does when its element goes: the virtualizer lets go of the elements no longer in the page.
    return () => measure(null);
  }, [measure, item.key]);
  return (
    <div ref={element} data-index={item.index} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
      {children}
    </div>
  );
}

// [LAW:dataflow-not-control-flow] What the line says of each way an exchange stands: nothing of one that completed,
// since its status says so, and of one still in flight; a word for the rest.
const endings = { ok: "", pending: "", unread: "no end read", error: "error", aborted: "aborted", stopped: "stopped" } as const;

// A block's row, beside the bar in its category's color, which runs its whole height (docs/design/02-design.md, "One
// bold element"): its line; under it, once its mark is clicked, what steps rewrote in it; and, expanded, its content.
// Clicking the line switches between expanded and not, from how the block starts.
function BlockView({ row }: { row: BlockRow }) {
  const starts = useSettings((state) => startsExpanded(row, state.visibility));
  const { open, toggle } = useToggle(row.key, starts);
  const rewrites = useToggle(pastKey(row.key), false);
  const block = blockOf(row);
  const size = sizeOf(block);
  return (
    <div className="ml-4 border-l-[3px] border-l-(--category) pr-4 pl-3" style={categoryVars(block.category)}>
      <div className="flex items-baseline gap-3 font-sans hover:bg-hover">
        <button type="button" className="flex min-w-0 flex-1 items-baseline gap-3 text-left" onClick={toggle}>
          <span className="w-3 text-foreground-muted">{open ? "▾" : "▸"}</span>
          {/* A block a step took away is struck: what the conversation held, no longer part of it. */}
          <span className={`min-w-0 truncate ${isGone(row) ? "text-foreground-muted line-through" : ""}`} title={block.name}>
            <HighlightedText blockKey={row.key} at={address.name} text={block.name} />
          </span>
          {/* Expanded, the content itself is below, so the line does not say it twice. */}
          <span className="min-w-0 flex-1 truncate font-mono text-foreground-muted">{open ? "" : preview(block)}</span>
        </button>
        <PastMark row={row} open={rewrites.open} toggle={rewrites.toggle} />
        <span className="tabular-nums text-foreground-muted" title={describeSize(size)}>
          {compact(size)}
        </span>
      </div>
      {rewrites.open && <Rewrites row={row} />}
      {open && (
        <div className="max-w-[110ch] pb-1 pl-6">
          <Sections.Provider value={sectionsStartOpen(block)}>
            {block.parts.map((part, index) => (
              <PartView key={index} part={part} blockKey={row.key} index={index} />
            ))}
          </Sections.Provider>
        </div>
      )}
    </div>
  );
}

// [LAW:dataflow-not-control-flow] What a block's line says a step did to it since it arrived.
const deeds: Record<Event["change"], string> = { changed: "rewritten", removed: "taken away", added: "sent again" };

// A block's past on its line: the last thing a step did to it since it arrived and at which step, and how many steps
// did anything, where more than one; nothing for a block as it arrived. It is in the foreground where the step shown
// did it, muted for an earlier step's. Where a step rewrote the block, a click shows what each rewrote, or hides it.
function PastMark({ row, open, toggle }: { row: BlockRow; open: boolean; toggle: () => void }) {
  const past = pastOf(row);
  const last = past.at(-1);
  if (last === undefined) return null;
  const says = `${deeds[last.change]} at step ${last.step}${past.length > 1 ? ` · ${past.length} changes` : ""}`;
  const color = row.change === "same" ? "text-foreground-muted" : "";
  return past.some(({ change }) => change === "changed") ? (
    <button
      type="button"
      data-past
      aria-expanded={open}
      title={open ? "Hide what each step rewrote" : "Show what each step rewrote"}
      className={`shrink-0 underline decoration-dotted underline-offset-2 hover:decoration-solid ${color}`}
      onClick={toggle}
    >
      {says}
    </button>
  ) : (
    <span data-past className={`shrink-0 ${color}`}>
      {says}
    </span>
  );
}

// What steps rewrote in a block, the latest first: under each step's line, the block before against the block after.
function Rewrites({ row }: { row: BlockRow }) {
  return pastOf(row)
    .toReversed()
    .map((event) =>
      event.change !== "changed" ? null : (
        <div key={event.step} data-rewrite={event.step} className="max-w-[110ch] pb-1 pl-6 font-mono break-words whitespace-pre-wrap">
          <div className="font-sans text-foreground-muted">rewritten at step {event.step}</div>
          <DiffLines lines={blockDiff(event.before, event.after)} foldKey={`${pastKey(row.key)}/${event.step}`} />
        </div>
      ),
    );
}

// A block diff's lines, each word in the weight and color of what the change did to it, and for each run of unchanged
// lines folded, a line saying how many, which opens and closes it on a click, kept by its place under `foldKey`;
// opened, the lines themselves, made only then.
function DiffLines({ lines, foldKey }: { lines: (DiffLine | LineFold)[]; foldKey: string }) {
  return lines.map((entry, index) =>
    entry.kind === "fold" ? (
      <DiffFold key={index} fold={entry} foldKey={`${foldKey}/${entry.at}`} />
    ) : (
      <DiffLineView key={index} change={entry.change}>
        {entry.words.map(({ change, text }, word) => (
          <span key={word} className={`${diffMarks[change].weight} ${diffMarks[change].color}`}>
            {text}
          </span>
        ))}
      </DiffLineView>
    ),
  );
}

function DiffFold({ fold, foldKey }: { fold: LineFold; foldKey: string }) {
  const { open, toggle } = useToggle(foldKey, false);
  return (
    <>
      <button type="button" className="flex w-full items-center gap-3 text-left font-sans text-foreground-muted hover:bg-hover" onClick={toggle}>
        <span className="w-3">{open ? "▾" : "▸"}</span>
        {fold.lines.length} unchanged lines
      </button>
      {open && <DiffLines lines={fold.lines} foldKey={foldKey} />}
    </>
  );
}

// A line of a unified diff: marked for what the change did to it and set on that mark's ground, verbatim. An empty line
// still takes a line's height, its mark's.
function DiffLineView({ change, children }: { change: Edit["change"]; children: ReactNode }) {
  const { ground, color } = diffMarks[change];
  return (
    <div className={`flex ${ground}`}>
      <span className={`w-3 shrink-0 select-none ${color}`}>{marks[change]}</span>
      <span className="min-w-0">{children}</span>
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
      return <TextView part={part} blockKey={blockKey} at={address.part(index)} />;
    case "json":
      return <JsonView part={part} blockKey={blockKey} at={address.part(index)} />;
    case "fields":
      return (
        // A name is as wide as it is up to 40% of the width, wrapping past it, so a long one leaves its value in view; a
        // field a field holds is indented under it.
        <dl className="grid grid-cols-[fit-content(40%)_1fr] gap-x-3">
          {fieldLines(part.fields).map(({ name, value, depth }, field) => (
            <div key={field} className="contents">
              <dt className="break-all text-foreground-muted" style={{ paddingLeft: `${depth * 2}ch` }}>
                <HighlightedText blockKey={blockKey} at={address.field(index, field, "name")} text={name} />
              </dt>
              <dd className="break-all whitespace-pre-wrap">
                {value !== undefined && <HighlightedText blockKey={blockKey} at={address.field(index, field, "value")} text={value} />}
              </dd>
            </div>
          ))}
        </dl>
      );
    case "diff":
      return <DiffView part={part} blockKey={blockKey} at={address.part(index)} />;
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

// [LAW:one-source-of-truth] The one table of how a diff, a part's or a block's, shows a line or a word by what the change
// did to it: a line on its ground, a word a block's diff marks within a line in its weight and color.
const diffMarks: Record<Edit["change"], { ground: string; color: string; weight: string }> = {
  same: { ground: "", color: "", weight: "" },
  removed: { ground: "bg-removed", color: "text-error", weight: "font-semibold" },
  added: { ground: "bg-added", color: "text-success", weight: "font-semibold" },
};

// A change as a unified diff: each line placed in the diff's text at its passage, so the search's matches paint where
// they are.
function DiffView({ part, blockKey, at }: { part: Extract<Part, { kind: "diff" }>; blockKey: string; at: string }) {
  const diff = diffOf(part);
  const where = useWhere(blockKey, at, diff);
  return (
    <div className="font-mono break-words whitespace-pre-wrap">
      {diff.lines.map((line, index) => (
        <DiffLineView key={index} change={line.change}>
          <Highlighted slice={line.text} from={diff.passages[index]!.start} where={where} />
        </DiffLineView>
      ))}
    </div>
  );
}

function JsonView({ part, blockKey, at }: { part: Extract<Part, { kind: "json" }>; blockKey: string; at: string }) {
  const text = jsonText(part);
  return (
    <pre className="break-all whitespace-pre-wrap">
      <HighlightedText blockKey={blockKey} at={at} text={text} />
    </pre>
  );
}
