import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { Segment } from "./history.ts";
import { conversationKeys, withKeys } from "./keyboard.ts";
import { failuresOf, mostOf, shapeOf, titleOf } from "./strip.ts";

// The steps of the conversation, above it (docs/design/02-design.md, "Two axes"): one mark per step, in the order
// they began, as tall as what it wrote and as strong as how long it took (strip.ts), the step shown marked in the theme's
// primary and a step that failed, or brought a tool's failed result, in its error color, each titled with the facts of
// its exchange line; a click on a mark goes to that step. Previous and next move one step, and say where the moment is
// among them. `shown`: the step shown, from 1. `onGo`: a move to a step; `onStep`: a move of one step, back or forward.
// More steps than the strip has pixels for scroll it sideways, the mark shown kept in view, so every mark can be reached.
export const TurnStrip = memo(function TurnStrip({
  segments,
  shown,
  onGo,
  onStep,
}: {
  segments: readonly Segment[];
  shown: number;
  onGo: (step: number) => void;
  onStep: (by: -1 | 1) => void;
}) {
  // Of the history, not the step shown, so a move in time walks none of it.
  const most = useMemo(() => mostOf(segments), [segments]);
  const failures = useMemo(() => failuresOf(segments), [segments]);
  return (
    <nav aria-label="Steps" className="flex h-7 items-center gap-2 bg-surface px-4 font-sans text-xs">
      <button type="button" className="control" disabled={shown <= 1} title={withKeys("The step before", conversationKeys.back)} onClick={() => onStep(-1)}>
        ←
      </button>
      <span className="w-[11ch] text-center tabular-nums text-foreground-muted">
        {shown} / {segments.length}
      </span>
      <button type="button" className="control" disabled={shown >= segments.length} title={withKeys("The step after", conversationKeys.forward)} onClick={() => onStep(1)}>
        →
      </button>
      <ol className="flex h-4 min-w-0 flex-1 items-end gap-px overflow-x-auto [scrollbar-width:none]">
        {segments.map((segment, index) => {
          const { formatted, branch } = segment;
          const failure = failures[index]!;
          const { height, opacity } = shapeOf(formatted.facts, most);
          return (
            <Mark
              key={formatted.exchange.trace_id}
              step={index + 1}
              title={titleOf(index + 1, formatted, branch?.from, failure)}
              height={height}
              opacity={opacity}
              failed={failure.exchange || failure.tool}
              branched={branch !== undefined}
              isShown={index + 1 === shown}
              onGo={onGo}
            />
          );
        })}
      </ol>
    </nav>
  );
});

// A step's mark: `height` a fraction of the strip's, `opacity` its strength, a request on a branch of its thread raised
// off the strip's floor below the thread's marks. Memoized on what it shows, each a value, so as an exchange streams, or
// the step shown moves, only the marks it changes render again.
const Mark = memo(function Mark({
  step,
  title,
  height,
  opacity,
  failed,
  branched,
  isShown,
  onGo,
}: {
  step: number;
  title: string;
  height: number;
  opacity: number;
  failed: boolean;
  branched: boolean;
  isShown: boolean;
  onGo: (step: number) => void;
}) {
  const mark = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    if (isShown) mark.current!.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isShown]);
  return (
    <li ref={mark} className={`flex h-full max-w-3 min-w-px flex-1 items-end ${branched ? "pb-[4px]" : ""}`}>
      <button
        type="button"
        aria-current={isShown ? "step" : undefined}
        title={title}
        // The step shown and a failed step at full strength, so neither is lost among faint marks.
        style={{ height: `${height * 100}%`, opacity: isShown || failed ? 1 : opacity }}
        className={`flex-1 rounded-[1px] ${marks[isShown ? "shown" : failed ? "failed" : "step"]}`}
        onClick={() => onGo(step)}
      />
    </li>
  );
});

// [LAW:dataflow-not-control-flow] How each mark is painted: the step shown, a failed step, or any other step.
const marks = { shown: "bg-(--primary)", failed: "bg-(--error)", step: "bg-foreground-disabled hover:bg-foreground-muted" } as const;
