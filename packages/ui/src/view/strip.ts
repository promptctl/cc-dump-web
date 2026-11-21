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

type TokenFacts = Pick<FormattedExchange["facts"], "input" | "cacheRead" | "cacheWritten" | "output">;

// [LAW:types-are-the-program] The kinds of a step's tokens, bottom to top in its mark, named as the facts name them.
export type Kind = "uncached" | "cacheRead" | "cacheWritten" | "output";
export type Part = { kind: Kind; count: number };

// [LAW:one-source-of-truth] A step's tokens by kind, which its stack draws and its total sums: the uncached input is what
// the input, which holds the cache's, holds beside them. A count not known yet, as a streaming step's, is none.
function tokensOf({ input, cacheRead = 0, cacheWritten = 0, output = 0 }: TokenFacts): Part[] {
  return [
    { kind: "uncached", count: input === undefined ? 0 : input - cacheRead - cacheWritten },
    { kind: "cacheRead", count: cacheRead },
    { kind: "cacheWritten", count: cacheWritten },
    { kind: "output", count: output },
  ];
}

const totalOf = (parts: readonly Part[]) => parts.reduce((total, { count }) => total + count, 0);

// The largest step's tokens, which every mark's height is relative to; 0 while none is known.
export const mostOf = (segments: readonly Segment[]): number => Math.max(0, ...segments.map(({ formatted: { facts } }) => totalOf(tokensOf(facts))));

// A mark's stack: its height, a fraction of the strip's, by its step's tokens against the largest step's, so the stacks
// climb as the context grows and drop where it is compacted; and its parts, each kind's count, which divide that height
// among them. [LAW:dataflow-not-control-flow] Always the four parts, a part of nothing drawing nothing. Each is its true
// size: an output under a pixel, as it is beside a long context, is not drawn larger, which would misstate the rest, and
// the mark's title says every count. Counts are whole, so while the largest is 0 every count is too, and a divisor of 1
// at the least keeps 0 / 0 out of the height.
export function stackOf(facts: TokenFacts, most: number): { height: number; parts: Part[] } {
  const parts = tokensOf(facts);
  return { height: totalOf(parts) / Math.max(most, 1), parts };
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
