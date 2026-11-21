import { memo, useLayoutEffect, useMemo, useRef, type WheelEvent } from "react";
import type { FormattedExchange } from "../format/format.ts";
import type { Segment } from "./history.ts";
import { conversationKeys, withKeys } from "./keyboard.ts";
import { failuresOf, mostOf, partedOf, stackOf, titleOf, type Kind } from "./strip.ts";

// The steps of the conversation, above it (docs/design/02-design.md, "Two axes"): one mark per step, in the order
// they began, as tall as its tokens against the largest step's and stacked by their kind (strip.ts), the step shown
// marked in the theme's primary and a step that failed, or brought a tool's failed result, in its error color, each
// titled with the facts of its exchange line; a click on a mark goes to that step. A step the column lists (`listed`,
// view/rows.ts) is solid and any other hollow, one of another history or one still to come, and a step where a history
// parts from another has a notch above it. Previous and next move one step, and say where the moment is among them.
// `shown`: the step shown, from 1. `onGo`: a move to a step; `onStep`: a move of one step, back or forward. A mark is
// never narrower than it can be told apart and pressed at; more steps than fit at that scroll the strip sideways, by
// the wheel too, the mark shown kept in view, so every mark can be reached.
export const TurnStrip = memo(function TurnStrip({
  segments,
  shown,
  listed,
  onGo,
  onStep,
}: {
  segments: readonly Segment[];
  shown: number;
  listed: ReadonlySet<number>;
  onGo: (step: number) => void;
  onStep: (by: -1 | 1) => void;
}) {
  // Of the history, not the step shown, so a move in time walks none of it.
  const most = useMemo(() => mostOf(segments), [segments]);
  const failures = useMemo(() => failuresOf(segments), [segments]);
  const parted = useMemo(() => partedOf(segments), [segments]);
  return (
    <nav aria-label="Steps" className="flex h-9 items-center gap-2 bg-surface px-4 font-sans text-xs">
      <button type="button" className="control" disabled={shown <= 1} title={withKeys("The step before", conversationKeys.back)} onClick={() => onStep(-1)}>
        ←
      </button>
      <span className="w-[11ch] text-center tabular-nums text-foreground-muted">
        {shown} / {segments.length}
      </span>
      <button type="button" className="control" disabled={shown >= segments.length} title={withKeys("The step after", conversationKeys.forward)} onClick={() => onStep(1)}>
        →
      </button>
      <ol className="flex h-7 min-w-0 flex-1 items-end gap-px overflow-x-auto [scrollbar-width:none]" onWheel={scrollAlong}>
        {segments.map(({ formatted }, index) => {
          const failure = failures[index]!;
          const isListed = listed.has(index + 1);
          return (
            <Mark
              key={formatted.exchange.trace_id}
              step={index + 1}
              title={titleOf(index + 1, formatted, isListed, failure)}
              facts={formatted.facts}
              most={most}
              failed={failure.exchange || failure.tool}
              hollow={!isListed}
              parted={parted.has(index + 1)}
              isShown={index + 1 === shown}
              onGo={onGo}
            />
          );
        })}
      </ol>
    </nav>
  );
});

// The wheel turned over the strip moves it along, the one way a strip goes, its scrollbar hidden; a sideways turn
// scrolls it already. The delta's mode, the DOM's, says what one of its units is: a pixel, a line, a page.
function scrollAlong(event: WheelEvent<HTMLOListElement>) {
  const strip = event.currentTarget;
  strip.scrollLeft += event.deltaY * [1, lineHeight, strip.clientWidth][event.deltaMode]!;
}

const lineHeight = 16;

// A step's mark: its stack, the step's tokens (strip.ts) against `most`, the largest step's, `hollow` for a step the
// column does not list, and, `parted`, the notch of a step with a sibling above it. The whole of its height is the press,
// and a line along its foot says the step is there whatever it holds. Memoized on what it shows, each a value or the
// facts its exchange's formatting keeps while they hold, so as an exchange streams, or the step shown moves, only the
// marks it changes render again.
const Mark = memo(function Mark({
  step,
  title,
  facts,
  most,
  failed,
  hollow,
  parted,
  isShown,
  onGo,
}: {
  step: number;
  title: string;
  facts: FormattedExchange["facts"];
  most: number;
  failed: boolean;
  hollow: boolean;
  parted: boolean;
  isShown: boolean;
  onGo: (step: number) => void;
}) {
  const mark = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (isShown) mark.current!.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isShown]);
  const { height, parts } = stackOf(facts, most);
  const paint = paints[isShown ? "shown" : failed ? "failed" : "step"];
  const listing = hollow ? { stack: `border ${paint.line}`, part: "" } : { stack: "", part: paint.fill };
  return (
    <li ref={mark} className="relative flex h-full max-w-3 min-w-1 flex-1 pt-1.5">
      {parted && <span aria-hidden className="absolute top-0 left-1/2 size-1 -translate-x-1/2 rotate-45 bg-foreground-muted" />}
      <button
        type="button"
        aria-current={isShown ? "step" : undefined}
        title={title}
        className={`group flex flex-1 flex-col justify-end border-b ${paint.line}`}
        onClick={() => onGo(step)}
      >
        <span style={{ height: `${height * 100}%` }} className={`flex flex-col-reverse rounded-t-[1px] ${listing.stack}`}>
          {parts.map(({ kind, count }) => (
            <span key={kind} style={{ flexGrow: count, opacity: strengths[kind] }} className={`basis-0 ${listing.part}`} />
          ))}
        </span>
      </button>
    </li>
  );
});

// [LAW:dataflow-not-control-flow] How each mark is painted: the step shown, a failed step, or any other step, its parts
// filled where the column lists it and its stack outlined where not.
const paints = {
  shown: { fill: "bg-(--primary)", line: "border-(--primary)" },
  failed: { fill: "bg-(--error)", line: "border-(--error)" },
  step: { fill: "bg-foreground-muted group-hover:bg-foreground", line: "border-foreground-muted group-hover:border-foreground" },
} as const;

// How strongly each kind of a step's tokens is drawn: what it wrote the strongest, then what it wrote to the cache, then
// what it read fresh, and what it read from the cache, most of most steps, the faintest. One hue to a mark, its paint's,
// so the strengths tell the kinds apart and no color is added to the theme's.
const strengths: Record<Kind, number> = { output: 1, cacheWritten: 0.75, uncached: 0.55, cacheRead: 0.35 };
