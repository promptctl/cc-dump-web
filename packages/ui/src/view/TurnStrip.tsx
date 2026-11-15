import { memo } from "react";
import type { Segment } from "./history.ts";
import { clockTime } from "./rows.ts";

// The conversation's steps, above the columns (docs/design/02-design.md, "Two axes"): one mark per step, in the order
// they began, the step shown marked in the theme's primary and a failed exchange in its error color, each titled with
// what it was; a click on a mark goes to that step. Previous and next move one step, and say where the moment is among
// them. `shown`: the step shown, from 1. `onGo`: a move to a step; `onStep`: a move of one step, back or forward.
export const TurnStrip = memo(function TurnStrip({
  segments,
  shown,
  onGo,
  onStep,
}: {
  segments: Segment[];
  shown: number;
  onGo: (step: number) => void;
  onStep: (by: -1 | 1) => void;
}) {
  return (
    <nav aria-label="Steps" className="flex h-7 items-center gap-2 bg-surface px-4 font-sans text-xs">
      <button type="button" className="control" disabled={shown <= 1} title="The step before (←)" onClick={() => onStep(-1)}>
        ←
      </button>
      <span className="w-[11ch] text-center tabular-nums text-foreground-muted">
        {shown} / {segments.length}
      </span>
      <button type="button" className="control" disabled={shown >= segments.length} title="The step after (→)" onClick={() => onStep(1)}>
        →
      </button>
      <ol className="flex h-3 min-w-0 flex-1 items-stretch gap-px overflow-hidden">
        {segments.map(({ formatted: { exchange, facts } }, index) => {
          const step = index + 1;
          const failed = exchange.end?.outcome === "error" || (facts.status !== undefined && facts.status >= 400);
          return (
            <li key={exchange.trace_id} className="flex max-w-3 min-w-px flex-1">
              <button
                type="button"
                aria-current={step === shown ? "step" : undefined}
                title={[`${step}`, clockTime(facts.began), facts.model, failed ? "failed" : undefined].filter((fact) => fact !== undefined).join(" · ")}
                className={`flex-1 rounded-[1px] ${marks[step === shown ? "shown" : failed ? "failed" : "step"]}`}
                onClick={() => onGo(step)}
              />
            </li>
          );
        })}
      </ol>
    </nav>
  );
});

// [LAW:dataflow-not-control-flow] How each mark is painted: the step shown, a failed exchange, or any other step.
const marks = { shown: "bg-(--primary)", failed: "bg-(--error)", step: "bg-foreground-disabled hover:bg-foreground-muted" } as const;
