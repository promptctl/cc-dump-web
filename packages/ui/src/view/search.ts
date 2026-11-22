import { carriedTo, diffOf } from "../format/diff.ts";
import { fieldLines, jsonText, type FieldLine, type Part } from "../format/parts.ts";
import type { KeyedBlock } from "../format/format.ts";
import type { SearchOptions } from "../settings.ts";
import { rankBefore, rankOf, type At } from "./position.ts";
import type { Range } from "./range.ts";
import { regionKey } from "./regions.ts";
import { regionsAround, renderingOf, type Folded } from "./rendering.ts";
import { blockOf, nestsOf, type BlockRow, type Row } from "./rows.ts";

// Search (docs/design/01-features.md, F6): the matches of a query in the texts every block shows, whichever category it is
// in, counted, stepped through in order, and found in each text shown for highlighting.

// A match: the block's row key, the address of the text it is in (`address`), and where it starts in that text as the
// reader sees it. A text that changes at its address, as a streaming Markdown text does when its text grows or a
// closing backtick or asterisk arrives, carries the match to where its characters went (`carried`).
export type Match = { key: string; at: string; start: number };

// [LAW:one-source-of-truth] The addresses of the texts a block shows: its name, a part's text or JSON by the part's id,
// the name or value of a field by the part's id and the field line's path. The search and the view both name a text by
// them. Each is a JSON tuple, so no two are alike, whatever an id or a field's name holds.
export const address = {
  name: JSON.stringify(["name"]),
  part: ({ id }: Pick<Part, "id">) => JSON.stringify(["part", id]),
  field: ({ id }: Pick<Part, "id">, { path }: Pick<FieldLine, "path">, side: "name" | "value") => JSON.stringify(["field", id, path, side]),
};

// The key of a block's part, under which its regions are kept: the block's row key and the part's address.
export function partKey(key: string, at: string): string {
  return `${key}/${at}`;
}

// [LAW:one-source-of-truth] The key of what opens on `line` of the text at `at` in the block's row `blockKey`, a long
// region or a heading's section: the choices keep it by this key, a step opens it by it, and a heading on that line is
// drawn with it as its id, so one name keeps a section and finds its heading.
export const keyAt = ({ blockKey, at }: { blockKey: string; at: string }, line: number): string => regionKey(partKey(blockKey, at), line);

// A text the search reads: its characters, and the passages of them a match is found within, in order; a match runs
// from no passage into the next.
export type Searched = { text: string; passages: Range[] };

// A text read whole, one passage.
export function whole(text: string): Searched {
  return { text, passages: [{ start: 0, end: text.length }] };
}

// A text a block shows: its address, the text, and where it shows: on the block's line, always on screen; in its
// content, while it is expanded; or in its content and inside the folds of it holding the match, while they are
// expanded too: a text part's rendering, what the reader sees, not the text as sent.
export type Shown = { at: string } & ({ in: "line" | "content"; searched: Searched } | { in: "regions"; searched: Folded });

// The texts a block's row shows, in the order it shows them: the block's name, then its parts; of a block a step took
// away as of any other, since its row shows them. Labels are the view's words, not the traffic's, media is shown as
// itself or a line describing it, what a step rewrote in a block is the view's account of it, and a text's contents
// say its headings again (contents.ts), so none is searched.
export function shownTexts(row: BlockRow): Shown[] {
  const block = blockOf(row);
  return [{ at: address.name, searched: whole(block.name), in: "line" }, ...block.parts.flatMap(partTexts)];
}

function partTexts(part: Part): Shown[] {
  switch (part.kind) {
    case "text":
      return [{ at: address.part(part), searched: renderingOf(part), in: "regions" }];
    case "json":
      return [{ at: address.part(part), searched: whole(jsonText(part)), in: "content" }];
    case "fields":
      return fieldLines(part.fields).flatMap((line): Shown[] => [
        { at: address.field(part, line, "name"), searched: whole(line.name), in: "content" },
        ...(line.value === undefined ? [] : [{ at: address.field(part, line, "value"), searched: whole(line.value), in: "content" } as const]),
      ]);
    case "diff":
      return [{ at: address.part(part), searched: diffOf(part), in: "content" }];
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

// The matches among the `rows`: how many, and the blocks holding them, in order and by key. It holds counts, not the
// matches: a one-letter query over a long recording matches millions of times.
export type Found = { count: number; blocks: FoundBlock[]; byKey: Map<string, FoundBlock>; rows: readonly Row[] };

// A search of rows for a pattern. [LAW:no-shared-mutable-globals] Its cache is its own: each block's count for each
// pattern, kept under the block, which the formatter returns as the same object while its side of the exchange is
// unchanged, so a frame counts only the blocks of the side it changed.
export function createSearch(): (rows: Row[], pattern: RegExp) => Found {
  const counted = new WeakMap<RegExp, WeakMap<KeyedBlock, number>>();
  return (rows, pattern) => {
    const counts = counted.get(pattern) ?? new WeakMap<KeyedBlock, number>();
    counted.set(pattern, counts);
    // The pattern that matches nothing finds nothing in any text, so it reads none: reading a text part renders it, and
    // with no query that would render every text of the recording as it opens and every event of a streamed reply.
    const countOf = (row: BlockRow) => {
      if (pattern === nothing) return 0;
      const count = counts.get(blockOf(row)) ?? shownTexts(row).reduce((sum, { searched }) => sum + find(pattern, searched).length, 0);
      counts.set(blockOf(row), count);
      return count;
    };
    const blocks: FoundBlock[] = [];
    let count = 0;
    rows.forEach((row, index) => {
      if (row.kind !== "block") return;
      const own = countOf(row);
      if (own === 0) return;
      blocks.push({ row, index, count: own, before: count });
      count += own;
    });
    return { count, blocks, byKey: new Map(blocks.map((block) => [block.row.key, block])), rows };
  };
}

// The matches of a block, in the order it shows them, each with the text it is in.
function matchesIn(row: BlockRow, pattern: RegExp): { match: Match; shown: Shown; order: number }[] {
  return shownTexts(row).flatMap((shown, order) => find(pattern, shown.searched).map(({ start }) => ({ match: { key: row.key, at: shown.at, start }, shown, order })));
}

const same = (a: Match, b: Match) => a.key === b.key && a.at === b.at && a.start === b.start;

// The text at `at` among those a block's row shows; none when it shows none there.
export const textAt = (row: BlockRow, at: string): Searched | undefined => shownTexts(row).find((shown) => shown.at === at)?.searched;

// The match `current` in its text as it shows now, `now`, which showed `before` when the match was last judged: its
// start carried to where that character went (format/diff.ts), so a match stays on its characters as the text grows
// after it or closes markup before it. It is current while a match of `pattern` starts there; none when the change took
// its first character, or no match starts there now. Where nothing moved it, it is `current` itself.
export function carried(current: Match, before: string, now: Searched, pattern: RegExp): Match | undefined {
  const start = carriedTo(before, now.text, current.start);
  if (start === undefined || !find(pattern, now).some((found) => found.start === start)) return undefined;
  return start === current.start ? current : { ...current, start };
}

// Which match `current` is, counting from 1, among the matches found: undefined when it is none of them, as when its
// block is one the formatter replaced.
export function ordinal(found: Found, current: Match | undefined, pattern: RegExp): number | undefined {
  const block = current === undefined ? undefined : found.byKey.get(current.key);
  if (block === undefined) return undefined;
  const index = matchesIn(block.row, pattern).findIndex(({ match }) => same(match, current!));
  return index === -1 ? undefined : block.before + index + 1;
}

// [LAW:types-are-the-program] A step to a match, and the `folds` that must show open for it to be on screen, by key:
// the nests its block is inside, innermost first, and the set it is in, so its block is listed; then, for a match in
// the block's content, not on its line, the block, and the regions and the headings' sections holding the match.
export type Step = { match: Match; folds: string[] };

export type Direction = "next" | "previous";

// Where a step of the search counts from: the current match, `match`, while there is one, or the reader's place; `at`:
// where that stands, in the order of every row, hidden or not, which `found` was made from (position.ts).
export type From = { match: Match | undefined; at: At };

// The match after or before the one `from` names, in the order the conversation shows them, wrapping at either end;
// undefined when there is no match. A current whose block is not among the rows stands at the end of the row standing
// in for it: the row it was inside when the formatter replaced it. So the steps go on from where it was. With no
// current, the steps start from the reader's place: its top row's matches first going on, and the matches above it
// going back.
export function adjacent(found: Found, from: From, direction: Direction, pattern: RegExp): Step | undefined {
  const forward = direction === "next";
  const pick = <T>(list: T[], is: (item: T) => boolean) => (forward ? list.find(is) : list.findLast(is));
  const ahead = (by: number) => (forward ? by > 0 : by < 0);
  // In its own block, the first match past it in the direction of the step.
  const own = from.match === undefined ? undefined : found.byKey.get(from.match.key);
  if (own !== undefined) {
    const { at, start } = from.match!;
    const text = shownTexts(own.row).findIndex((shown) => shown.at === at);
    const past = pick(matchesIn(own.row, pattern), ({ match, order }) => ahead(order - text || match.start - start));
    if (past !== undefined) return stepTo(found, own, past);
  }
  // Where the step starts among the rows (position.ts): after the current match's place, or before the reader's, so the
  // matches of the row at the view's top are ahead.
  const place = from.match === undefined ? rankBefore(from.at) : rankOf(from.at);
  const block = pick(found.blocks, (block) => ahead(block.index - place)) ?? (forward ? found.blocks[0] : found.blocks.at(-1));
  if (block === undefined) return undefined;
  const matches = matchesIn(block.row, pattern);
  return stepTo(found, block, (forward ? matches[0] : matches.at(-1))!);
}

function stepTo({ rows }: Found, { row, index }: FoundBlock, { match, shown }: { match: Match; shown: Shown }): Step {
  const listed = [...nestsOf(rows, index), ...(row.set === undefined ? [] : [row.set])];
  switch (shown.in) {
    case "line":
      return { match, folds: listed };
    case "content":
      return { match, folds: [...listed, row.key] };
    case "regions":
      return { match, folds: [...listed, row.key, ...regionsAround(shown.searched, match.start).map((line) => keyAt({ blockKey: row.key, at: shown.at }, line))] };
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
