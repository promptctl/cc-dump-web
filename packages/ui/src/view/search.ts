import { diffOf } from "../format/diff.ts";
import { fieldLines, jsonText, type Part } from "../format/parts.ts";
import type { KeyedBlock } from "../format/format.ts";
import type { SearchOptions } from "../settings.ts";
import { blockDiff, type BlockDiff } from "./change.ts";
import { rowIndex, type Position } from "./position.ts";
import type { Range } from "./range.ts";
import { regionKey } from "./regions.ts";
import { regionsAround, renderingOf, type Folded } from "./rendering.ts";
import { type Keys, type Row } from "./rows.ts";

// Search (docs/design/01-mvp.md, F6): the matches of a query in the texts every block shows, whichever category it is
// in, counted, stepped through in order, and found in each text shown for highlighting.

// A block row the search reads: one showing a block on the right, the moment shown, which a removed row does not.
export type BlockRow = Extract<Row, { kind: "block"; block: KeyedBlock }>;

// A match: the block's row key, the address of the text it is in (`address`), and where it starts in that text. A text
// that changes at its address names by that offset whichever match starts there now, or none: a tool's input so far
// replaced by its JSON once whole, or a streaming Markdown text whose rendering a closing backtick or asterisk shortens.
export type Match = { key: string; at: string; start: number };

// [LAW:one-source-of-truth] The addresses of the texts a block shows: its name, a part's text or JSON, the name or value
// of a part's field, and in place of its parts, a changed block's diff. The search and the view both name a text by them.
export const address = {
  name: "name",
  change: "change",
  part: (part: number) => String(part),
  field: (part: number, field: number, side: "name" | "value") => `${part}/${field}/${side}`,
};

// The key of a block's part, under which its regions are kept: the block's row key and the part's address.
export function partKey(key: string, at: string): string {
  return `${key}/${at}`;
}

// A text the search reads: its characters, and the passages of them a match is found within, in order; a match runs
// from no passage into the next.
export type Searched = { text: string; passages: Range[] };

// A text read whole, one passage.
export function whole(text: string): Searched {
  return { text, passages: [{ start: 0, end: text.length }] };
}

// A text a block shows: its address, the text, and where it shows: on the block's line, always on screen; in its
// content, while it is expanded; or in its content and inside the folds of it holding the match, while they are
// expanded too: a text part's rendering, what the reader sees, not the text as sent, or a changed block's diff.
export type Shown = { at: string } & ({ in: "line" | "content"; searched: Searched } | { in: "regions"; searched: Folded });

// What a block row shows on the right, under which the search keeps its count: a changed block, its diff with the
// version before, made once per pair of versions; any other, the block.
function shownOf(row: BlockRow): KeyedBlock | BlockDiff {
  return row.change === "changed" ? blockDiff(row.before, row.block) : row.block;
}

// The texts a block row shows on the right, in the order it shows them: the block's name, then its parts, or a changed
// block's diff in their place. Labels are the view's words, not the traffic's, and media is shown as itself or a line
// describing it, so neither is searched.
export function shownTexts(row: BlockRow): Shown[] {
  const name: Shown = { at: address.name, searched: whole(row.block.name), in: "line" };
  return row.change === "changed"
    ? [name, { at: address.change, searched: blockDiff(row.before, row.block).right, in: "regions" }]
    : [name, ...row.block.parts.flatMap((part, index) => partTexts(part, index))];
}

function partTexts(part: Part, index: number): Shown[] {
  switch (part.kind) {
    case "text":
      return [{ at: address.part(index), searched: renderingOf(part), in: "regions" }];
    case "json":
      return [{ at: address.part(index), searched: whole(jsonText(part)), in: "content" }];
    case "fields":
      return fieldLines(part.fields).flatMap(({ name, value }, field): Shown[] => [
        { at: address.field(index, field, "name"), searched: whole(name), in: "content" },
        ...(value === undefined ? [] : [{ at: address.field(index, field, "value"), searched: whole(value), in: "content" } as const]),
      ]);
    case "diff":
      return [{ at: address.part(index), searched: diffOf(part), in: "content" }];
    case "media":
      return [];
  }
}

// A query as read under the search's options: the `pattern` its matches are found with, and `error`, why it is not one,
// as the regular expression engine words it, when it is not a valid regular expression. [LAW:dataflow-not-control-flow]
// A query that is none has a pattern that matches nothing, so the search runs the same for it, and what it shows is
// that it found nothing, and why.
export type Query = { pattern: RegExp; error: string | undefined };

// The pattern that matches nothing: the empty query's, so no search is a pattern like any other, and an invalid one's.
export const nothing = new RegExp("(?!)", "gu");

// What a word is made of, in Unicode: letters, digits and the underscore, as `\w` is in ASCII. JavaScript's `\b` is
// ASCII only, so it would find a boundary inside "café".
const word = String.raw`[\p{L}\p{N}_]`;

// [LAW:parse-dont-validate] The one place a query is parsed: read under `options` as its characters, or as a regular
// expression when `regex` is on; in any case unless `caseSensitive`; and with no word character beside a match when
// `wholeWord`.
export function patternOf(query: string, { caseSensitive, wholeWord, regex }: SearchOptions): Query {
  if (query === "") return { pattern: nothing, error: undefined };
  const source = regex ? query : RegExp.escape(query);
  const flags = caseSensitive ? "gu" : "giu";
  try {
    // The query is compiled alone first: inside the group that wraps it for a whole word, an unbalanced one such as
    // `a)(b` could close the group and still compile, as another expression.
    const alone = new RegExp(source, flags);
    return { pattern: wholeWord ? new RegExp(`(?<!${word})(?:${source})(?!${word})`, flags) : alone, error: undefined };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { pattern: nothing, error: error.message };
  }
}

// [LAW:single-enforcer] Where a pattern matches a text, in order: the one definition of a match, which the count, the
// highlighting and the steps between matches all use. A match has characters: where an expression matches nothing, as
// `x*` can, there is nothing to highlight and nowhere to step.
export function find(pattern: RegExp, { text, passages }: Searched): Range[] {
  return passages.flatMap(({ start: from, end: to }) =>
    Array.from(text.slice(from, to).matchAll(pattern), (found) => ({ start: from + found.index, end: from + found.index + found[0].length })).filter(({ start, end }) => end > start),
  );
}

// A block with matches: its row, the row's index among the rows, how many matches it holds, and how many come before.
export type FoundBlock = { row: BlockRow; index: number; count: number; before: number };

// The matches among the rows: how many, and the blocks holding them, in order and by key. It holds counts, not the
// matches: a one-letter query over a long recording matches millions of times.
export type Found = { count: number; blocks: FoundBlock[]; byKey: Map<string, FoundBlock> };

// A search of rows for a pattern. [LAW:no-shared-mutable-globals] Its cache is its own: each block's count for each
// pattern, kept under the block, which the formatter returns as the same object while its side of the exchange is
// unchanged, so a frame counts only the blocks of the side it changed.
export function createSearch(): (rows: Row[], pattern: RegExp) => Found {
  const counted = new WeakMap<RegExp, WeakMap<KeyedBlock | BlockDiff, number>>();
  return (rows, pattern) => {
    const counts = counted.get(pattern) ?? new WeakMap<KeyedBlock | BlockDiff, number>();
    counted.set(pattern, counts);
    // The pattern that matches nothing finds nothing in any text, so it reads none: reading a text part renders it, and
    // with no query that would render every text of the recording as it opens and every event of a streamed reply.
    const countOf = (row: BlockRow) => {
      if (pattern === nothing) return 0;
      const shown = shownOf(row);
      const count = counts.get(shown) ?? shownTexts(row).reduce((sum, { searched }) => sum + find(pattern, searched).length, 0);
      counts.set(shown, count);
      return count;
    };
    const blocks: FoundBlock[] = [];
    let count = 0;
    rows.forEach((row, index) => {
      const own = row.kind === "block" && row.change !== "removed" ? countOf(row) : 0;
      if (own === 0) return;
      blocks.push({ row: row as BlockRow, index, count: own, before: count });
      count += own;
    });
    return { count, blocks, byKey: new Map(blocks.map((block) => [block.row.key, block])) };
  };
}

// The matches of a block, in the order it shows them, each with the text it is in.
function matchesIn(row: BlockRow, pattern: RegExp): { match: Match; shown: Shown; order: number }[] {
  return shownTexts(row).flatMap((shown, order) => find(pattern, shown.searched).map(({ start }) => ({ match: { key: row.key, at: shown.at, start }, shown, order })));
}

const same = (a: Match, b: Match) => a.key === b.key && a.at === b.at && a.start === b.start;

// Which match `current` is, counting from 1, among the matches found: undefined when it is none of them, as when its
// block is one the formatter replaced.
export function ordinal(found: Found, current: Match | undefined, pattern: RegExp): number | undefined {
  const block = current === undefined ? undefined : found.byKey.get(current.key);
  if (block === undefined) return undefined;
  const index = matchesIn(block.row, pattern).findIndex(({ match }) => same(match, current!));
  return index === -1 ? undefined : block.before + index + 1;
}

// A step to a match, and what must show expanded for it to be on screen: its block's row, unless the match is on the
// block's line, and the regions holding it, by key, which all start collapsed.
export type Step = { match: Match; block: BlockRow | undefined; regions: string[] };

export type Direction = "next" | "previous";

// The match after or before `current`, in the order the conversation shows them, wrapping at either end; undefined
// when there is no match. `order`: the places of every row, hidden or not, which `found` was made from. A current whose
// block is not among them stands just after the row `rowIndex` gives for it, as the view does: the row it was inside
// when the formatter replaced it. So the steps go on from where it was. With no current, the steps start from the
// view's `position`: its top row's matches first going on, and the matches above it going back. One whose exchange is
// not among the rows goes to the first match, or back to the last.
export function adjacent(found: Found, current: Match | undefined, position: Position, direction: Direction, pattern: RegExp, order: Keys): Step | undefined {
  const forward = direction === "next";
  const pick = <T>(list: T[], is: (item: T) => boolean) => (forward ? list.find(is) : list.findLast(is));
  const ahead = (by: number) => (forward ? by > 0 : by < 0);
  // In its own block, the first match past it in the direction of the step.
  const own = current === undefined ? undefined : found.byKey.get(current.key);
  if (own !== undefined) {
    const { at, start } = current!;
    const text = shownTexts(own.row).findIndex((shown) => shown.at === at);
    const past = pick(matchesIn(own.row, pattern), ({ match, order }) => ahead(order - text || match.start - start));
    if (past !== undefined) return stepTo(own.row, past);
  }
  // Where the step starts among the rows; `bias`: where it stands against its row when the row is among them.
  const placeOf = (key: string, bias: number) => {
    const own = order.indexOf(key);
    if (own !== undefined) return own + bias;
    const inside = rowIndex(key, order.indexOf);
    return inside === undefined ? (forward ? -Infinity : Infinity) : inside + 0.5;
  };
  const place =
    current !== undefined ? placeOf(current.key, 0) : position.at === "row" ? placeOf(position.key, -0.5) : position.at === "start" ? -Infinity : Infinity;
  const block = pick(found.blocks, (block) => ahead(block.index - place)) ?? (forward ? found.blocks[0] : found.blocks.at(-1));
  if (block === undefined) return undefined;
  const matches = matchesIn(block.row, pattern);
  return stepTo(block.row, (forward ? matches[0] : matches.at(-1))!);
}

function stepTo(row: BlockRow, { match, shown }: { match: Match; shown: Shown }): Step {
  switch (shown.in) {
    case "line":
      return { match, block: undefined, regions: [] };
    case "content":
      return { match, block: row, regions: [] };
    case "regions":
      return { match, block: row, regions: regionsAround(shown.searched, match.start).map((line) => regionKey(partKey(row.key, shown.at), line)) };
  }
}

// The ranges of a text's matches, `ranges`, that hold any of its characters from `from` up to `to`, so none of an empty
// slice: a match can run from one leaf of a rendering into the next, as one across emphasis does. They are in order
// and apart, so their ends are in order too, a binary search finds the first, and a text cut into many slices is not
// scanned whole for each.
export function rangesIn(ranges: Range[], from: number, to: number): Range[] {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.end <= from) low = middle + 1;
    else high = middle;
  }
  let end = low;
  while (end < ranges.length && Math.max(ranges[end]!.start, from) < Math.min(ranges[end]!.end, to)) end++;
  return ranges.slice(low, end);
}
