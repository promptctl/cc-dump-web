import type { FormattedExchange } from "../format/format.ts";
import type { Segment } from "./history.ts";
import { clockTime, compact, modelName, seconds } from "./rows.ts";

// The turn strip's marks (docs/design/02-design.md, "Layout"), the horizontal navigator: each step's shape and what it
// says on hover, pure.

// What went wrong at a step: its exchange failed (an error, or an HTTP error status), or what it brought into the
// conversation holds a tool's result that says its tool failed.
export type Failure = { exchange: boolean; tool: boolean };

export function failureOf({ formatted: { exchange, facts }, groups }: Segment): Failure {
  return {
    exchange: exchange.end?.outcome === "error" || (facts.status !== undefined && facts.status >= 400),
    tool: groups.some(({ items }) => items.some(({ versions }) => versions[0]!.block?.failed === true)),
  };
}

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

// What a mark says on hover: the exchange line's facts (view/Conversation.tsx's ExchangeLine), then where the step stands
// and what went wrong.
export function titleOf(step: number, { facts }: FormattedExchange, off: number | undefined, failure: Failure): string {
  const count = (label: string, value: number | undefined) => (value === undefined ? undefined : `${label} ${compact(value)}`);
  return [
    `${step}`,
    clockTime(facts.began),
    facts.model === undefined ? undefined : modelName(facts.model),
    facts.duration === undefined ? undefined : seconds(facts.duration),
    facts.status === undefined ? undefined : `${facts.status}`,
    [count("in", facts.input), count("cache", facts.cacheRead), count("written", facts.cacheWritten), count("out", facts.output)].filter((fact) => fact !== undefined).join(" ") || undefined,
    off === undefined ? undefined : `branch off ${off}`,
    failure.exchange ? "failed" : undefined,
    failure.tool ? "a tool failed" : undefined,
  ]
    .filter((fact) => fact !== undefined)
    .join(" · ");
}
