import { rowIndex, type Position } from "./position.ts";
import { blockOf, type Keys, type Row } from "./rows.ts";
import type { Direction } from "./search.ts";

// The block the harness injected (format/blocks.ts) that is listed next after the view's `position`, or before it, by
// its row's key: the first whose row starts after the position, or the last whose row starts before it, and past the
// last one the one at the other end, as a step of the search goes around. A block the position is at the very start
// of is neither, so a move after a move goes on from it. Undefined when none is listed. `rows`: the rows listed, each
// at the place `indexOf` gives its key. A position whose row has not arrived, as after a reload, is before them all.
export function injectedFrom(rows: readonly Row[], indexOf: Keys["indexOf"], position: Position, direction: Direction): string | undefined {
  const injected = rows.flatMap((row, index) => (row.kind === "block" && blockOf(row).injected !== undefined ? [{ key: row.key, index }] : []));
  // The row the position is in, and whether it is `past` that row's start: some way into it, or in a row not listed,
  // for which the row listed before it stands (rowIndex), at whose end the view then is (resolve).
  const at = position.at === "end" ? rows.length : position.at === "start" ? -1 : (rowIndex(position.key, indexOf) ?? -1);
  const past = position.at === "row" && (rows[at]?.key !== position.key || position.offset > 0);
  const found =
    direction === "next" ? (injected.find(({ index }) => index > at) ?? injected[0]) : (injected.findLast(({ index }) => index < at || (past && index === at)) ?? injected.at(-1));
  return found?.key;
}
