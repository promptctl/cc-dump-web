import { rowIndex, type Position } from "./position.ts";
import type { ForkRow, Keys, Row } from "./rows.ts";
import type { Direction } from "./search.ts";

// The fork a press of [ or ] switches at (docs/design/02-design.md, "Keys"): the nearest above the view, the last
// whose line is listed at or before the row at the view's top, `top`, or, with none there, the first listed.
// Undefined where the column lists no fork. `rows`: the rows listed, each at the place `indexOf` gives its key. A top
// whose row has not arrived, as after a reload, is before them all.
export function forkAbove(rows: readonly Row[], indexOf: Keys["indexOf"], top: Exclude<Position, { at: "end" }>): ForkRow | undefined {
  const at = top.at === "start" ? -1 : (rowIndex(top.key, indexOf) ?? -1);
  const forks = rows.flatMap((row, index) => (row.kind === "fork" ? [{ row, index }] : []));
  return (forks.findLast(({ index }) => index <= at) ?? forks[0])?.row;
}

// The sibling a switch at a fork goes to, by its first step: the one listed after, or before, the sibling the view is
// at, around the ends. The view is at the sibling a move is already going to, `aimed`, where it is one of the fork's,
// so a switch made while one runs goes on from it, and otherwise at the one the column shows. From none, as before any
// of them arrived, a switch goes to the first, or, going back, to the last.
export function siblingFrom({ siblings, shown }: ForkRow, aimed: number | undefined, direction: Direction): number {
  const going = siblings.findIndex(({ step }) => step === aimed);
  const at = going === -1 ? siblings.findIndex(({ step }) => step === shown) : going;
  const to = direction === "next" ? at + 1 : Math.max(at, 0) - 1;
  return siblings[(to + siblings.length) % siblings.length]!.step;
}
