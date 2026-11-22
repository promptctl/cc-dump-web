import { rankOf, type At } from "./position.ts";
import { blockOf, type Row } from "./rows.ts";
import type { Direction } from "./search.ts";

// The block the harness injected (format/blocks.ts) that is listed next after the reader's place `at`, or before it,
// by its row: the first whose row starts after the place, or the last whose row starts before it, and past the last one
// the one at the other end, as a step of the search goes around. A block the place is at the very start of is neither,
// so a move after a move goes on from it. Undefined when none is listed. `rows`: the rows listed, in the order `at` was
// judged in (position.ts).
export function injectedFrom(rows: readonly Row[], at: At, direction: Direction): string | undefined {
  const stop = (row: Row) => row.kind === "block" && blockOf(row).injected !== undefined;
  const injected = rows.flatMap((row, index) => (stop(row) ? [{ key: row.key, index }] : []));
  const rank = rankOf(at);
  const found = direction === "next" ? (injected.find(({ index }) => index > rank) ?? injected[0]) : (injected.findLast(({ index }) => index < rank) ?? injected.at(-1));
  return found?.key;
}
