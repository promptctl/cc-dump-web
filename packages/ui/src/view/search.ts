import type { Block, Part } from "../format/blocks.ts";
import type { KeyedBlock } from "../format/format.ts";
import { rowIndex, type Position } from "./position.ts";
import { regionKey, segments, type Segment } from "./regions.ts";
import type { Keys, Row } from "./rows.ts";

// Search (docs/design/01-mvp.md, F6): the matches of a query in the texts the shown categories' blocks show, counted,
// stepped through in order, and cut out of each text for highlighting.

export type BlockRow = Extract<Row, { kind: "block" }>;

// A match: the block's row key, the address of the text it is in (`address`), and where it starts in that text.
// A text part only grows at its end as it streams, so a match in it keeps its place. A text replaced at its address, as
// a tool's input so far is by its JSON once whole, names by that offset whichever match starts there now, or none.
export type Match = { key: string; at: string; start: number };

// A match's characters in its text, from `start` up to `end`.
export type Range = { start: number; end: number };

// [LAW:one-source-of-truth] The addresses of the texts a block shows: its name, a part's text or JSON, and the name or
// value of a part's field. The search and the view both name a text by them.
export const address = {
  name: "name",
  part: (part: number) => String(part),
  field: (part: number, field: number, side: "name" | "value") => `${part}/${field}/${side}`,
};

// The key of a block's part, under which its regions are kept: the block's row key and the part's address.
export function partKey(key: string, at: string): string {
  return `${key}/${at}`;
}

// A text a block shows: its address, the text, and where it shows: on the block's line, always on screen; in its
// content, while it is expanded; or in its content and inside a region of it, a text part's, while that is expanded too.
export type Shown = { at: string; text: string; in: "line" | "content" | "regions" };

// The texts a block shows, in the order it shows them. Labels are the view's words, not the traffic's, and media is
// shown as itself or a line describing it, so neither is searched.
export function shownTexts(block: Block): Shown[] {
  return [{ at: address.name, text: block.name, in: "line" }, ...block.parts.flatMap((part, index) => partTexts(part, index))];
}

function partTexts(part: Part, index: number): Shown[] {
  switch (part.kind) {
    case "text":
      return [{ at: address.part(index), text: part.text, in: "regions" }];
    case "json":
      return [{ at: address.part(index), text: jsonText(part.value), in: "content" }];
    case "fields":
      return part.fields.flatMap(([name, value], field) => [
        { at: address.field(index, field, "name"), text: name, in: "content" as const },
        { at: address.field(index, field, "value"), text: value, in: "content" as const },
      ]);
    case "media":
      return [];
  }
}

// The text a JSON part shows.
export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "undefined";
}

// [LAW:parse-dont-validate] A query as the pattern its matches are found with: its characters literally, in any case
// (search options are not in the MVP). The empty query matches nothing, so no search is a pattern like any other.
export function patternOf(query: string): RegExp {
  return new RegExp(query === "" ? "(?!)" : RegExp.escape(query), "giu");
}

// [LAW:single-enforcer] Where a pattern matches a text, in order: the one definition of a match, which the count, the
// highlighting and the steps between matches all use.
export function find(pattern: RegExp, text: string): Range[] {
  return Array.from(text.matchAll(pattern), (found) => ({ start: found.index, end: found.index + found[0].length }));
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
  const counted = new WeakMap<RegExp, WeakMap<KeyedBlock, number>>();
  return (rows, pattern) => {
    const counts = counted.get(pattern) ?? new WeakMap<KeyedBlock, number>();
    counted.set(pattern, counts);
    const countOf = (block: KeyedBlock) => {
      const count = counts.get(block) ?? shownTexts(block).reduce((sum, { text }) => sum + find(pattern, text).length, 0);
      counts.set(block, count);
      return count;
    };
    const blocks: FoundBlock[] = [];
    let count = 0;
    rows.forEach((row, index) => {
      const own = row.kind === "block" ? countOf(row.block) : 0;
      if (own === 0) return;
      blocks.push({ row: row as BlockRow, index, count: own, before: count });
      count += own;
    });
    return { count, blocks, byKey: new Map(blocks.map((block) => [block.row.key, block])) };
  };
}

// The matches of a block, in the order it shows them, each with the text it is in.
function matchesIn(row: BlockRow, pattern: RegExp): { match: Match; shown: Shown; order: number }[] {
  return shownTexts(row.block).flatMap((shown, order) => find(pattern, shown.text).map(({ start }) => ({ match: { key: row.key, at: shown.at, start }, shown, order })));
}

const same = (a: Match, b: Match) => a.key === b.key && a.at === b.at && a.start === b.start;

// Which match `current` is, counting from 1, among the matches found: undefined when it is none of them, as when its
// block is hidden.
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
// when there is no match. A current whose row is not listed stands just after the row `rowIndex` gives for it, as the
// view does: the row listed before it when its category is hidden, or the row it was inside when the formatter replaced
// it. So the steps go on from where it was. With no current, the steps start from the view's `position`: its top row's
// matches first going on, and the matches above it going back. One whose exchange is not among the rows goes to the
// first match, or back to the last.
export function adjacent(found: Found, current: Match | undefined, position: Position, direction: Direction, pattern: RegExp, keys: Keys): Step | undefined {
  const forward = direction === "next";
  const pick = <T>(list: T[], is: (item: T) => boolean) => (forward ? list.find(is) : list.findLast(is));
  const ahead = (by: number) => (forward ? by > 0 : by < 0);
  // In its own block, the first match past it in the direction of the step.
  const own = current === undefined ? undefined : found.byKey.get(current.key);
  if (own !== undefined) {
    const { at, start } = current!;
    const text = shownTexts(own.row.block).findIndex((shown) => shown.at === at);
    const past = pick(matchesIn(own.row, pattern), ({ match, order }) => ahead(order - text || match.start - start));
    if (past !== undefined) return stepTo(own.row, past);
  }
  // Where the step starts among the rows; `own`: where it stands against its row when the row is listed.
  const placeOf = (key: string, own: number) => {
    const index = rowIndex(key, keys.indexOf);
    return index === undefined ? (forward ? -Infinity : Infinity) : keys.at(index) === key ? index + own : index + 0.5;
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
      return { match, block: row, regions: regionsAround(segments(shown.text), match.start).map((line) => regionKey(partKey(row.key, shown.at), line)) };
  }
}

// The opening lines of the regions holding offset `start`, outermost first. One on a region's closing line is in no
// segment of its body.
function regionsAround(list: Segment[], start: number): number[] {
  const segment = list.find(({ end }) => start < end);
  if (segment?.kind !== "region") return [];
  return [segment.line, ...(start >= segment.start + segment.open.length ? regionsAround(segment.body, start) : [])];
}

// A piece of a text: plain, or part of the match starting at `match`.
export type Piece = { text: string; match: number | undefined };

// A slice of a text, starting at offset `from` in it, cut where `ranges` (the text's matches) begin and end.
export function pieces(slice: string, from: number, ranges: Range[]): Piece[] {
  const to = from + slice.length;
  const out: Piece[] = [];
  let at = from;
  for (let index = firstEndingAfter(ranges, from); index < ranges.length && ranges[index]!.start < to; index++) {
    const { start, end } = ranges[index]!;
    const begin = Math.max(start, at);
    if (begin > at) out.push({ text: slice.slice(at - from, begin - from), match: undefined });
    const stop = Math.min(end, to);
    out.push({ text: slice.slice(begin - from, stop - from), match: start });
    at = stop;
  }
  if (at < to) out.push({ text: slice.slice(at - from), match: undefined });
  return out;
}

// The index of the first of `ranges` ending after `offset`. A text's matches are in order and apart, so a binary search
// finds it, and a text cut into many slices is not scanned whole for each.
function firstEndingAfter(ranges: Range[], offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

// [LAW:one-source-of-truth] The id a match's mark carries in the page, by which the view finds it.
export function matchId({ key, at, start }: Match): string {
  return JSON.stringify([key, at, start]);
}
