import { memo, useLayoutEffect, useMemo, useRef, type WheelEvent } from "react";
import type { Segment } from "./history.ts";
import { conversationKeys, withKeys } from "./keyboard.ts";
import { lineHeightOf } from "./lineHeight.ts";
import { failuresOf, kinds, mostOf, partedOf, stackOf, titleOf, wheelPixels, type Kind, type TokenFacts } from "./strip.ts";

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
              // The step shown is marked as shown where it failed too, which its title says.
              state={index + 1 === shown ? "shown" : failure.exchange || failure.tool ? "failed" : "step"}
              hollow={!isListed}
              parted={parted.has(index + 1)}
              onGo={onGo}
            />
          );
        })}
      </ol>
    </nav>
  );
});

// The wheel turned over the strip moves it along, the one way a strip goes, its scrollbar hidden (strip.ts).
function scrollAlong(event: WheelEvent<HTMLOListElement>) {
  const strip = event.currentTarget;
  strip.scrollLeft += wheelPixels(event, { line: lineHeightOf(strip), page: strip.clientWidth });
}

// The step a mark is of: the step shown, a step that failed, or any other step.
type State = "shown" | "failed" | "step";

// A step's mark: its stack, the step's tokens (strip.ts) against `most`, the largest step's, under its headroom,
// `hollow` for a step the column does not list, and, `parted`, the notch of a step with a sibling above it. The whole of
// its height is the press, and a line along its foot says the step is there whatever it holds. Memoized on what it
// shows, each a value or the facts its exchange's formatting keeps while they hold, so as an exchange streams, or the
// step shown moves, only the marks it changes render again.
const Mark = memo(function Mark({
  step,
  title,
  facts,
  most,
  state,
  hollow,
  parted,
  onGo,
}: {
  step: number;
  title: string;
  facts: TokenFacts;
  most: number;
  state: State;
  hollow: boolean;
  parted: boolean;
  onGo: (step: number) => void;
}) {
  const mark = useRef<HTMLLIElement>(null);
  const isShown = state === "shown";
  useLayoutEffect(() => {
    if (isShown) mark.current!.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isShown]);
  const { counts, tokens, headroom } = stackOf(facts, most);
  const paint = paints[state];
  return (
    <li ref={mark} className="group relative flex h-full max-w-3 min-w-1 flex-1 pt-1.5">
      {parted && <span aria-hidden className="absolute top-0 left-1/2 size-1 -translate-x-1/2 rotate-45 bg-foreground-muted" />}
      <button
        type="button"
        aria-current={isShown ? "step" : undefined}
        title={title}
        className={`flex flex-1 flex-col justify-end ${paint.foot} ${paint.line}`}
        onClick={() => onGo(step)}
      >
        <span style={{ flexGrow: headroom }} className="basis-0" />
        <span style={{ flexGrow: tokens }} className={`flex basis-0 flex-col rounded-t-[1px] ${hollow ? `border ${paint.line}` : ""}`}>
          {kinds.map((kind) => (
            <span key={kind} style={{ flexGrow: counts[kind], opacity: paint.strengths[kind] }} className={`basis-0 ${hollow ? "" : paint.fill}`} />
          ))}
        </span>
      </button>
    </li>
  );
});

// [LAW:dataflow-not-control-flow] How each mark is painted, by the step it is of: its hue, which fills its stack where
// the column lists the step and outlines it where not, and how strongly each kind of its tokens is drawn. What the step
// wrote is the strongest, then what it wrote to the cache, then the input the cache did not hold, and what it read from
// the cache, the prefix it resent and most of most steps, the faintest, so what each step added stands out. One hue to
// a mark, so the strengths tell the kinds apart and no color is added to the theme's. The step shown and a failed step
// are drawn stronger throughout, and stand on a heavier foot, which is there whatever the step holds, as a failure the
// API answered with no message holds none: so neither is lost among the faint marks.
const strong: Record<Kind, number> = { output: 1, cacheWritten: 0.9, uncached: 0.8, cacheRead: 0.7 };
const paints: Record<State, { fill: string; line: string; foot: string; strengths: Record<Kind, number> }> = {
  shown: { fill: "bg-(--primary)", line: "border-(--primary)", foot: "border-b-[3px]", strengths: strong },
  failed: { fill: "bg-(--error)", line: "border-(--error)", foot: "border-b-[3px]", strengths: strong },
  step: {
    fill: "bg-foreground-muted group-hover:bg-foreground",
    line: "border-foreground-muted group-hover:border-foreground",
    foot: "border-b",
    strengths: { output: 1, cacheWritten: 0.75, uncached: 0.55, cacheRead: 0.35 },
  },
};
