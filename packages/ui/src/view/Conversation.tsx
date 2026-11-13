import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { Exchange } from "../exchanges.ts";
import type { Part } from "../format/blocks.ts";
import type { FormattedExchange } from "../format/format.ts";
import { positionAt, rowIndex } from "./position.ts";
import { segments, type Segment } from "./regions.ts";
import { createLayout, describeSize, estimateHeight, isExpanded, type Row } from "./rows.ts";
import { step, type Cause } from "./scroll.ts";
import { settings, useSettings } from "../settings.ts";
import { useView, view } from "./state.ts";

// The conversation, scrolling: each exchange's request, then its response, as rows of which only those on screen are
// mounted (docs/design/01-mvp.md, F4). `reading`: whether the read can still bring an exchange its end.
export function Conversation({ formatted, reading }: { formatted: FormattedExchange[]; reading: boolean }) {
  // Fast Refresh keeps state but re-runs memos, so an edited module's layout is the one used.
  const layOut = useMemo(() => createLayout(), []);
  const { rows, keys } = useMemo(() => layOut(formatted), [layOut, formatted]);
  const flipped = useView((state) => state.flipped);
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
      const position = useView.getState().position;
      const anchor = position.at === "row" ? rowIndex(position.key, keys.indexOf) : undefined;
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
  // A click on a block or region is reading where the view is: the position becomes the place under the view, so
  // following pauses, and the line clicked stays where it is as what it opens grows or shrinks below it.
  const hold = useCallback(() => {
    view.moveTo(positionAt(scroller.current!.scrollTop, virtualizer.getVirtualItemForOffset));
    latest.current("choose");
  }, [virtualizer]);

  return (
    // The browser's own scroll anchoring would be a second writer of the offset.
    <main ref={scroller} className="flex flex-1 flex-col overflow-y-auto [overflow-anchor:none]">
      {rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No Messages API exchanges yet.</p>
      ) : (
        <Hold.Provider value={hold}>
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
        </Hold.Provider>
      )}
      {/* A sticky child of the scroller, held at its bottom, and after the rows, so at the end it is below the last row
          rather than over it. A click takes no focus: once it is clicked, End and Space still scroll the conversation,
          and Space does not press it again. */}
      <div className="pointer-events-none sticky bottom-0 mt-auto flex justify-end px-4 pt-1 pb-3">
        <button
          type="button"
          data-follow={following}
          aria-pressed={control.pressed}
          title={control.title}
          className="pointer-events-auto rounded-md border bg-background px-2 py-1 text-xs shadow-sm hover:bg-muted"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleFollow}
        >
          {control.label}
        </button>
      </div>
    </main>
  );
}

// The control in each state of follow mode: whether it is pressed, its label and its title.
const followStates = {
  on: { pressed: true, label: "Following", title: "The view stays at the newest content. Click to stop following." },
  paused: {
    pressed: "mixed",
    label: "Follow paused",
    title: "Away from the newest content. Scroll back to the end, or click, to follow again.",
  },
  off: { pressed: false, label: "Follow off", title: "Click to follow the newest content." },
} as const;

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
      return <h2 className="px-4 pt-1 pl-8 text-muted-foreground">{row.title}</h2>;
    case "block":
      return <BlockView row={row} />;
  }
});

// `reading`: whether the read can still bring this exchange its end.
function ExchangeLine({ exchange: { request, response, end }, reading }: { exchange: Exchange; reading: boolean }) {
  return (
    <div className="flex gap-3 border-t px-4 pt-1.5">
      {request.head ? (
        <span className="flex-1 truncate">
          {request.head.method} {request.head.url}
        </span>
      ) : (
        <span className="flex-1 text-muted-foreground">request not recorded</span>
      )}
      {response.head && (
        <span>
          {response.head.status} {response.head.reason}
        </span>
      )}
      {/* How it ended, beside its status: a response that began can still be cut, and one streaming has not ended. */}
      <span className={end?.outcome === "error" ? "text-destructive" : "text-muted-foreground"} title={end?.error}>
        {end?.outcome ?? (reading ? "pending" : "no end read")}
      </span>
    </div>
  );
}

// A block: collapsed, one line naming it and its size; expanded, that line and all its parts. Clicking the line
// switches between them.
function BlockView({ row }: { row: Extract<Row, { kind: "block" }> }) {
  const { key, block, size } = row;
  const open = useView((state) => isExpanded(state.flipped, row));
  const hold = useContext(Hold);
  return (
    <div className="pl-12 pr-4">
      <button
        type="button"
        className="flex w-full gap-3 text-left hover:bg-muted"
        onClick={() => {
          hold();
          view.toggle(key);
        }}
      >
        <span className="w-3 text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="w-20 text-muted-foreground">{block.category}</span>
        <span className="flex-1 truncate">{block.name}</span>
        <span className="text-muted-foreground">{describeSize(size)}</span>
      </button>
      {open && (
        <div className="pb-1 pl-6">
          {block.parts.map((part, index) => (
            <PartView key={index} part={part} partKey={`${key}/${index}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function PartView({ part, partKey }: { part: Part; partKey: string }) {
  return (
    <div className="py-0.5">
      {part.label !== undefined && <div className="text-muted-foreground">{part.label}</div>}
      <PartContent part={part} partKey={partKey} />
    </div>
  );
}

function PartContent({ part, partKey }: { part: Part; partKey: string }) {
  switch (part.kind) {
    case "text":
      return <TextView text={part.text} partKey={partKey} />;
    case "json":
      return <JsonView value={part.value} />;
    case "fields":
      return (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3">
          {part.fields.map(([name, value], index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="break-all whitespace-pre-wrap">{value}</dd>
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

function JsonView({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "undefined", [value]);
  return <pre className="break-all whitespace-pre-wrap">{text}</pre>;
}

// A text with its long regions (code blocks, tagged sections), each collapsing and expanding as a block does.
function TextView({ text, partKey }: { text: string; partKey: string }) {
  const segmented = useMemo(() => segments(text), [text]);
  return <pre className="break-words whitespace-pre-wrap">{segmentViews(segmented, partKey)}</pre>;
}

// `partKey`: the key of the part whose text it is.
function segmentViews(list: Segment[], partKey: string): ReactNode[] {
  return list.map((segment, index) =>
    segment.kind === "text" ? <span key={index}>{segment.text}</span> : <RegionView key={index} region={segment} partKey={partKey} />,
  );
}

// A long region starts collapsed: its line names it and how many lines it spans. It is kept by its part's key and the
// line it opens on.
function RegionView({ region, partKey }: { region: Extract<Segment, { kind: "region" }>; partKey: string }) {
  const regionKey = `${partKey}/${region.line}`;
  const open = useView((state) => state.flipped[regionKey] === true);
  const hold = useContext(Hold);
  const line = (
    <button
      type="button"
      className="text-muted-foreground hover:bg-muted"
      onClick={() => {
        hold();
        view.toggle(regionKey);
      }}
    >
      {open ? "▾" : "▸"} {region.label} · {region.lines} lines
    </button>
  );
  return open ? (
    <span>
      {line}
      {"\n"}
      {region.open}
      {segmentViews(region.body, partKey)}
      {region.close}
    </span>
  ) : (
    <span>
      {line}
      {"\n"}
    </span>
  );
}
