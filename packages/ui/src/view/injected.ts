import { rowIndex, type Position } from "./position.ts";
import { blockOf, type Keys, type Row } from "./rows.ts";
import type { Direction } from "./search.ts";

// The block the harness injected (format/blocks.ts) that is listed next after the view's `position`, or before it, by
// its row's key: the first after the position's row, or the last before it, and past the last one the one at the other
// end, as a step of the search goes around. Undefined when none is listed. `rows`: the rows listed, each at the place
// `indexOf` gives its key. A position whose row has not arrived, as after a reload, is before them all.
export function injectedFrom(rows: readonly Row[], indexOf: Keys["indexOf"], position: Position, direction: Direction): string | undefined {
  const injected = rows.flatMap((row, index) => (row.kind === "block" && blockOf(row).injected !== undefined ? [{ key: row.key, index }] : []));
  const from = position.at === "end" ? rows.length : position.at === "start" ? -1 : (rowIndex(position.key, indexOf) ?? -1);
  const found = direction === "next" ? (injected.find(({ index }) => index > from) ?? injected[0]) : (injected.findLast(({ index }) => index < from) ?? injected.at(-1));
  return found?.key;
}
