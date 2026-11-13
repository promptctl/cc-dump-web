import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { Exchange } from "../exchanges.ts";
import type { Part } from "../format/blocks.ts";
import type { FormattedExchange } from "../format/format.ts";
import { positionAt, resolve, rowIndex } from "./position.ts";
import { segments, type Segment } from "./regions.ts";
import { createLayout, describeSize, estimateHeight, isExpanded, type Row } from "./rows.ts";
import { useView, view } from "./state.ts";

// The conversation, scrolling: each exchange's request, then its response, as rows of which only those on screen are
// mounted (docs/design/01-mvp.md, F4). `reading`: whether the read can still bring an exchange its end.
export function Conversation({ formatted, reading }: { formatted: FormattedExchange[]; reading: boolean }) {
  // Fast Refresh keeps state but re-runs memos, so an edited module's layout is the one used.
  const layOut = useMemo(() => createLayout(), []);
  const { rows, keys } = useMemo(() => layOut(formatted), [layOut, formatted]);
  const toggled = useView((state) => state.toggled);
  const scroller = useRef<HTMLElement>(null);
  // The UI is not built with React Compiler, so nothing memoizes the virtualizer's functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    getItemKey: keys.at,
    estimateSize: (index) => estimateHeight(rows[index]!, isExpanded(toggled, rows[index]!)),
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

  // The offset the view last wrote. A scroller is created at 0, so 0 is where it starts, as if written there.
  const written = useRef(0);
  // [LAW:no-ambient-temporal-coupling] The one step that keeps the scroll offset and the position in agreement, run
  // after every render and on every scroll, in whatever order they come. An offset the view did not write is a scroll
  // someone else made (the reader, or the browser clamping a list that got shorter), whether its event has fired yet or
  // not: the position becomes where it is. Otherwise the position is resolved against where the rows now are, and
  // written when it moved; a position whose row has not arrived, as after a reload, writes nothing until it does.
  const sync = () => {
    const element = scroller.current!;
    const offset = element.scrollTop;
    if (Math.abs(offset - written.current) >= 1) {
      written.current = offset;
      view.moveTo(positionAt(offset, virtualizer.getVirtualItemForOffset));
      return;
    }
    const target = resolve(useView.getState().position, keys.indexOf, (index) => virtualizer.measurementsCache[index]);
    if (target === undefined || Math.abs(target - offset) < 1) return;
    element.scrollTop = target;
    // The browser clamps an offset past the end, so what was written is what it reads back.
    written.current = element.scrollTop;
  };
  const latestSync = useRef(sync);
  latestSync.current = sync;
  useLayoutEffect(() => latestSync.current());
  useLayoutEffect(() => {
    const element = scroller.current!;
    const onScroll = () => latestSync.current();
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  return (
    // The browser's own scroll anchoring would be a second writer of the offset.
    <main ref={scroller} className="flex-1 overflow-y-auto [overflow-anchor:none]">
      {rows.length === 0 ? (
        <p className="flex h-full items-center justify-center text-sm text-muted-foreground">No Messages API exchanges yet.</p>
      ) : (
        <div className="relative font-mono text-xs" style={{ height: virtualizer.getTotalSize() }}>
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
      )}
    </main>
  );
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
  const open = useView((state) => isExpanded(state.toggled, row));
  return (
    <div className="pl-12 pr-4">
      <button type="button" className="flex w-full gap-3 text-left hover:bg-muted" onClick={() => view.toggle(key, open)}>
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
      const { source } = part;
      switch (source.type) {
        case "base64":
          return source.media_type.startsWith("image/") ? (
            <img className="max-h-96" src={`data:${source.media_type};base64,${source.data}`} alt={source.media_type} />
          ) : (
            <p>
              {source.media_type}, {describeSize(source.data.length)} of base64
            </p>
          );
        case "url":
          return <p className="break-all">{source.url}</p>;
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
  const open = useView((state) => state.toggled[regionKey] ?? false);
  const line = (
    <button type="button" className="text-muted-foreground hover:bg-muted" onClick={() => view.toggle(regionKey, open)}>
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
