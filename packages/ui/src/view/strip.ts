import type { FormattedExchange } from "../format/format.ts";
import { forksOf, type Segment } from "./history.ts";
import { clockTime, compact, countsOf, modelName, seconds, statusFailed } from "./rows.ts";

// The turn strip's marks (docs/design/02-design.md, "Layout"), the horizontal navigator: each step's shape and what it
// says on hover, pure.

// What went wrong at a step: its exchange failed (an error, or an HTTP error status), or what it brought into the
// conversation, an item or an item's next version, holds a tool's result that says its tool failed.
export type Failure = { exchange: boolean; tool: boolean };

// Each step's failure, in the order of the steps: one walk over every item's versions, each of them brought by its step.
export function failuresOf(segments: readonly Segment[]): Failure[] {
  const toolFailed = new Set(
    segments.flatMap(({ groups }) => groups.flatMap(({ items }) => items.flatMap(({ versions }) => versions.flatMap(({ step, block }) => (block?.failed ? [step] : []))))),
  );
  return segments.map(({ formatted: { exchange, facts } }, index) => ({
    exchange: exchange.end?.outcome === "error" || statusFailed(facts.status),
    tool: toolFailed.has(index + 1),
  }));
}

// The steps of the recording that have a sibling, a step that stands after what they do (view/history.ts): each is
// where a history parts from another, which its mark says with a notch.
export const partedOf = (segments: readonly Segment[]): ReadonlySet<number> => new Set([...forksOf(segments).values()].flat());

// The largest output and duration among the steps, which a mark's shape is relative to; 0 while none is known.
export type Most = { output: number; duration: number };

export function mostOf(segments: readonly Segment[]): Most {
  return segments.reduce(
    (most, { formatted: { facts } }) => ({ output: Math.max(most.output, facts.output ?? 0), duration: Math.max(most.duration, facts.duration ?? 0) }),
    { output: 0, duration: 0 },
  );
}

// A mark's shape: its height, a fraction of the strip's, by its output against the most any step wrote, never less than a
// quarter so every step can be pressed; and its opacity by its duration against the longest, never less than 0.4 so every
// step is seen. A step whose output or duration is not known yet, as one still streaming, is the least.
export function shapeOf({ output, duration }: Pick<FormattedExchange["facts"], "output" | "duration">, most: Most): { height: number; opacity: number } {
  const share = (value: number | undefined, of: number) => (of === 0 || value === undefined ? 0 : value / of);
  return { height: 0.25 + 0.75 * share(output, most.output), opacity: 0.4 + 0.6 * share(duration, most.duration) };
}

// What a mark says on hover: the exchange line's facts (view/Conversation.tsx's ExchangeLine), then whether the column
// lists the step, where it does not, and what went wrong.
export function titleOf(step: number, { facts }: FormattedExchange, listed: boolean, failure: Failure): string {
  const counts = countsOf(facts).flatMap(([label, count]) => (count === undefined ? [] : [`${label} ${compact(count)}`]));
  return [
    `${step}`,
    clockTime(facts.began),
    facts.model === undefined ? undefined : modelName(facts.model),
    facts.duration === undefined ? undefined : seconds(facts.duration),
    facts.status === undefined ? undefined : `${facts.status}`,
    counts.join(" ") || undefined,
    listed ? undefined : "not in the column",
    failure.exchange ? "failed" : undefined,
    failure.tool ? "a tool failed" : undefined,
  ]
    .filter((fact) => fact !== undefined)
    .join(" · ");
}
