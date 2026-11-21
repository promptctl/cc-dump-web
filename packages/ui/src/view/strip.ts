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

// [LAW:types-are-the-program] The kinds of a step's tokens, named as the facts name them, in the order its stack draws
// them, top to bottom: the output, over what it wrote to the cache, over what it read from the cache, over the input
// the cache did not hold at the foot.
export type Kind = "output" | "cacheWritten" | "cacheRead" | "uncached";
export const kinds: readonly Kind[] = ["output", "cacheWritten", "cacheRead", "uncached"];
export type TokenFacts = Pick<FormattedExchange["facts"], Kind>;

// A mark's stack: `counts`, each kind's count of its step's tokens, `tokens`, all of them, and `headroom`, what the
// largest step's tokens hold above them, so a stack and its headroom together fill the strip's height, and the stacks
// climb as the context grows and drop where it is compacted. Each count is its true size: an output under a pixel, as
// it is beside a long context, is not drawn larger, which would misstate the rest. [LAW:dataflow-not-control-flow] A
// count not reported, as one a streaming step's message has not said yet, draws nothing until it is; the mark's title
// leaves it out.
export type Stack = { counts: Record<Kind, number>; tokens: number; headroom: number };

const countsIn = (facts: TokenFacts) => Object.fromEntries(kinds.map((kind) => [kind, facts[kind] ?? 0])) as Record<Kind, number>;
const totalOf = (facts: TokenFacts) => Object.values(countsIn(facts)).reduce((total, count) => total + count, 0);

// The largest step's tokens, which every stack is drawn against.
export const mostOf = (segments: readonly Segment[]): number => segments.reduce((most, { formatted: { facts } }) => Math.max(most, totalOf(facts)), 0);

export function stackOf(facts: TokenFacts, most: number): Stack {
  const tokens = totalOf(facts);
  return { counts: countsIn(facts), tokens, headroom: most - tokens };
}

// What one unit of a wheel's delta is, by the DOM's delta mode: a pixel, a line or a page.
export type DeltaUnit = "pixel" | "line" | "page";
export function deltaUnitOf(mode: number): DeltaUnit {
  const unit = (["pixel", "line", "page"] as const)[mode];
  if (unit === undefined) throw new Error(`a wheel's delta mode the DOM does not define: ${mode}`);
  return unit;
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
