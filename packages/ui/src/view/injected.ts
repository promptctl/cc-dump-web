import { top, type Direction, type Slot } from "./position.ts";
import { blockOf, type Row } from "./rows.ts";

// The block the harness injected (format/blocks.ts) that is listed next after the reader's place, `from`, or before
// it, by its row's key: the first whose row starts after it, or the last whose row starts before it, and past the last
// one the one at the other end, as a step of the search goes around. A block the place is at the very top of is
// neither, so a move after a move goes on from it. Undefined when none is listed. `rows`: the rows listed, which `from`
// is a slot among.
export function injectedFrom(rows: readonly Row[], from: Slot, direction: Direction): string | undefined {
  const stop = (row: Row) => row.kind === "block" && blockOf(row).injected !== undefined;
  const injected = rows.flatMap((row, index) => (stop(row) ? [{ key: row.key, index }] : []));
  const found = direction === "next" ? (injected.find(({ index }) => top(index) > from) ?? injected[0]) : (injected.findLast(({ index }) => top(index) < from) ?? injected.at(-1));
  return found?.key;
}
