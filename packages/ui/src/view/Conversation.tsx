import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { diffOf, type DiffLine } from "../format/diff.ts";
import type { Part } from "../format/parts.ts";
import type { FormattedExchange, KeyedBlock } from "../format/format.ts";
import { categoryVars } from "../theme/theme.ts";
import { createHistory, type Branch, type History } from "./history.ts";
import { inMotion } from "./motion.ts";
import { positionAt, rowIndex, type Position } from "./position.ts";
import { clockTime, compact, context, createLayout, describeSize, estimateHeight, foldKey, isExpanded, jsonText, modelName, preview, seconds, sizeOf, type Change, type Layout, type Row } from "./rows.ts";
import { step, type Cause } from "./scroll.ts";
import { FilterBar } from "./FilterBar.tsx";
import { SearchBar } from "./SearchBar.tsx";
import { currentMatch } from "./highlights.ts";
import { Highlighted, HighlightedText } from "./Highlighted.tsx";
import { Hold, Painted, Side, unpainted, useWhere } from "./painting.ts";
import { TextView } from "./Text.tsx";
import { address, adjacent, createSearch, ordinal, patternOf, type Direction } from "./search.ts";
import { settings, useSettings } from "../settings.ts";
import { useView, view, type Moment } from "./state.ts";
import { Toggle } from "./Toggle.tsx";
import { TurnStrip } from "./TurnStrip.tsx";

// The conversation side by side in time (docs/design/02-design.md, "Two axes"): two columns over one scroll, the
// conversation at the moment shown on the right and a step before on the left, aligned, as rows of which only those on
// screen are mounted (docs/design/01-mvp.md, F4); a window too narrow for two shows the right alone. `reading`: whether
// the read can still bring an exchange its end.
export function Conversation({ formatted, reading }: { formatted: FormattedExchange[]; reading: boolean }) {
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
  const unchanged = useSettings((state) => state.unchanged);
  const branches = useSettings((state) => state.branches);
  const layOut = useMemo(() => createLayout(visibility, unchanged, branches), [visibility, unchanged, branches]);
  // The search's current match is listed whichever its category (F6), so a step to a hidden category's block shows it, and
  // the step after, which makes another current, hides it again.
  const current = useView((state) => state.search.current);
  const revealed = current?.key;
  const flipped = useView((state) => state.flipped);
  const { rows, keys, every } = useMemo(() => layOut(conversation, shown, revealed, flipped), [layOut, conversation, shown, revealed, flipped]);
  // The position's row, which is always mounted: a step to a match commits with that row on screen.
  const anchorKey = useView((state) => (state.position.at === "row" ? state.position.key : undefined));
  const scroller = useRef<HTMLElement>(null);
  // The UI is not built with React Compiler, so nothing memoizes the virtualizer's functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    getItemKey: keys.at,
    estimateSize: (index) => estimateHeight(rows[index]!, flipped),
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
      placed: (index: number) => virtualizer.measurementsCache[index],
      rowAt: virtualizer.getVirtualItemForOffset,
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
  const painted = useMemo(() => ({ right: { pattern, current: true }, left: unpainted }), [pattern]);
  // A step to a match, as one act: it is committed with its block and regions open and its row mounted, then the view
  // is put at the match's line, a few of its lines below the top.
  const stepTo = (direction: Direction) => {
    const next = adjacent(found, current, useView.getState().position, direction, pattern, every.keys);
    if (next === undefined) return;
    flushSync(() => view.goTo(next, now));
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
  const hold = useCallback(() => {
    view.place(positionAt(scroller.current!.scrollTop, virtualizer.getVirtualItemForOffset), "reader", now);
    latest.current("choose");
  }, [virtualizer, now]);

  // A move in time to step `target`: the moment becomes that step, now if it is the latest, and the view is put `context`
  // rows above the step's first change, or, following, at the end. Committed first, so the position is put among the
  // step's own rows.
  const toStep = (target: number) => {
    const latestStep = target === steps;
    const position: Position = latestStep && useSettings.getState().follow ? { at: "end" } : beforeChange(layOut(conversation, target, revealed, flipped));
    flushSync(() => view.moveInTime(latestStep ? { at: "now" } : { at: "chosen", trace: conversation.segments[target - 1]!.formatted.exchange.trace_id }, position));
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
  // The moves, through the render last committed, so the strip's marks, memoized, render only as what they show changes.
  const moves = useRef({ go, goBy, toStep });
  useLayoutEffect(() => {
    moves.current = { go, goBy, toStep };
  });
  const onGo = useCallback((target: number) => moves.current.go(target), []);
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
      {/* The browser's own scroll anchoring would be a second writer of the offset. The area is what a move in time
          slides (index.css). */}
      <main ref={scroller} className="flex flex-1 flex-col overflow-y-auto [overflow-anchor:none] [view-transition-name:conversation]">
        {rows.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-sm text-foreground-muted">No Messages API exchanges yet</p>
        ) : (
          <Hold.Provider value={hold}>
            <Painted.Provider value={painted}>
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

// The place `context` rows above the first row a layout's step brought, so what the step did is in view with what it
// follows. A row a branch placement removed is not the step's, and its own exchange is always one it brought.
function beforeChange({ rows, keys }: Layout): Position {
  const first = rows.findIndex((row) => row.kind !== "fold" && brought[row.change]);
  return { at: "row", key: keys.at(Math.max(0, first - context)), offset: 0 };
}
const brought: Record<Change, boolean> = { added: true, changed: true, removed: false, same: false };

// The keys that move in time, and whether an element takes them for its own: a field typed or chosen in.
const arrows: Partial<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowRight: 1 };
function takesKeys(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

// The largest scroll offset: the one that shows the end of the conversation.
function largest(element: HTMLElement): number {
  return element.scrollHeight - element.clientHeight;
}

// A row: a fold across both columns; anything else its two sides, aligned, with a band between them in the color of
// what the step did, none where it left the row as it was. Below `lg` only the right side shows. The band stands where
// a ground would: the theme's text is promised legible on its muted grounds only in their own `text-` color, and the
// foreground fails on them in most themes. Memoized on what it shows, every field of the row, so a row the layout makes
// again as it was does not render again.
const RowView = memo(
  function RowView({ row, reading }: { row: Row; reading: boolean }) {
    if (row.kind === "fold") return <FoldLine fold={row} />;
    const sides = sidesOf(row, reading);
    // A branch's rows stand one step in, under the thread they left (docs/design/02-design.md, "Two axes").
    const inset = row.branch === undefined ? undefined : "pl-6";
    return (
      <div className="grid grid-cols-[4px_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_4px_minmax(0,1fr)]">
        <div className={`hidden lg:block ${inset ?? ""}`}>
          <Side.Provider value="left">{sides.left}</Side.Provider>
        </div>
        <div className={bands[row.change]} />
        <div className={inset}>{sides.right}</div>
      </div>
    );
  },
  (before, after) => before.reading === after.reading && sameFields(before.row, after.row),
);

// What each side of a row shows: the right, the moment shown; the left, the step before, nothing where the step added
// the row, and the right nothing where it removed it.
function sidesOf(row: Exclude<Row, { kind: "fold" }>, reading: boolean): { left: ReactNode; right: ReactNode } {
  const sides = (line: ReactNode) => ({ left: row.change === "added" ? null : line, right: row.change === "removed" ? null : line });
  switch (row.kind) {
    case "exchange":
      return sides(<ExchangeLine exchange={row.exchange} branch={row.branch} reading={reading} />);
    case "group":
      return sides(<h2 className="pt-2 pl-7 font-sans text-[11px] tracking-wider text-foreground-muted uppercase">{row.title}</h2>);
    case "block":
      return {
        left: row.before === undefined ? null : <BlockView rowKey={row.key} block={row.before} />,
        right: row.block === undefined ? null : <BlockView rowKey={row.key} block={row.block} />,
      };
  }
}

// [LAW:dataflow-not-control-flow] The band between a row's sides, by what the step did to it.
const bands: Record<Change, string> = { added: "bg-(--success)", changed: "bg-(--warning)", removed: "bg-(--error)", same: "" };

// Whether two rows show the same: every field the same value.
function sameFields(a: Row, b: Row): boolean {
  const fields = Object.entries(a);
  return fields.length === Object.keys(b).length && fields.every(([name, value]) => (b as Record<string, unknown>)[name] === value);
}

// A run of unchanged rows, or of a branch's, folded: one line saying how many, across both columns, which opens it on a
// click.
function FoldLine({ fold }: { fold: Extract<Row, { kind: "fold" }> }) {
  const hold = useContext(Hold);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 py-0.5 pl-7 text-left font-sans text-foreground-muted hover:bg-hover"
      onClick={() => {
        hold();
        view.toggle(foldKey(fold.key));
      }}
    >
      <span className="w-3">▸</span>
      {fold.branch === undefined ? `${fold.count} unchanged` : `branch off ${fold.branch.from} · ${fold.count} rows`}
    </button>
  );
}

// The exchange's line (docs/design/02-design.md, "Print what varies", "Layout"): its facts in columns of fixed widths,
// aligned down the conversation, on two rows: who answered and how it ended, then the tokens. The model's column alone
// gives way to a narrow side, cut with an ellipsis, as is any rare value that outgrows its column. It is a band on the
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
      <span className={facts.status !== undefined && facts.status >= 400 ? "text-error" : undefined} title={reason}>
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
        <Fact label="in" count={facts.input} />
        <Fact label="cache" count={facts.cacheRead} />
        <Fact label="written" count={facts.cacheWritten} />
        <Fact label="out" count={facts.output} />
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

// [LAW:dataflow-not-control-flow] What the line says of each way an exchange stands: nothing of one that completed,
// since its status says so, and of one still in flight; a word for the rest.
const endings = { ok: "", pending: "", unread: "no end read", error: "error", aborted: "aborted", stopped: "stopped" } as const;

// A block, one side's version of the row at `rowKey`: collapsed, one line naming it, a preview of its content and its
// size; expanded, that line and all its parts. Clicking the line switches between them, on both sides. The gutter bar
// in its category's color runs its whole height (docs/design/02-design.md, "One bold element").
function BlockView({ rowKey: key, block }: { rowKey: string; block: KeyedBlock }) {
  const size = sizeOf(block);
  const open = useView((state) => isExpanded(state.flipped, key, block));
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
      return <TextView part={part} blockKey={blockKey} at={address.part(index)} />;
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

// A change as a unified diff: each line marked for what the change did to it and set on that mark's ground, verbatim,
// placed in the diff's text at its passage so the search's matches paint where they are.
const diffMarks: Record<DiffLine["change"], { mark: string; ground: string; color: string }> = {
  same: { mark: " ", ground: "", color: "" },
  removed: { mark: "-", ground: "bg-removed", color: "text-error" },
  added: { mark: "+", ground: "bg-added", color: "text-success" },
};
function DiffView({ part, blockKey, at }: { part: Extract<Part, { kind: "diff" }>; blockKey: string; at: string }) {
  const diff = diffOf(part);
  const where = useWhere(blockKey, at, diff);
  return (
    <div className="font-mono break-words whitespace-pre-wrap">
      {diff.lines.map((line, index) => {
        const { mark, ground, color } = diffMarks[line.change];
        return (
          <div key={index} className={`flex ${ground}`}>
            <span className={`w-3 shrink-0 select-none ${color}`}>{mark}</span>
            <span className="min-w-0">
              <Highlighted slice={line.text} from={diff.passages[index]!.start} where={where} />
            </span>
          </div>
        );
      })}
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
