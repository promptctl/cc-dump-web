import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import type { Ending } from "@cc-dump/log/ending";
import { unitOfWork } from "../log.ts";
import { sameFields } from "./history.ts";
import type { Waiting } from "./moves.ts";
import type { Gone } from "./rows.ts";
import type { Cause, Kept, Stepped } from "./scroll.ts";
import type { Moment } from "./state.ts";

// A step the view took (scroll.ts `step`), as its decisions read it: what it was given and what it gave.
export type StepTaken = { cause: Cause; offset: number; end: number; kept: Kept; next: Stepped };

// [LAW:single-enforcer] [LAW:nothing-unseen] The view's decisions about the reader's view, each written to `log` as an
// event of its own, in the parts' shape, with the facts that decided it, so a place that moved says what moved it:
// - `place_replaced`: the view gave the kept place up for the place under it, and why (scroll.ts `GaveUp`).
// - `reader_scroll`: the view took an offset for the reader's, so the place, the view's until then, became the one under
//   it, with the offset, the one the view last wrote or took, and the end, which tell a scroll from a clamp.
// - `match_cleared`: the current match is one nothing will bring, and why.
// - `moment_replaced`: the moment shown is one the read ended without, and now's is shown instead.
// - `moves_held` as a place or a match not read yet begins to hold the moves, and `moves_freed`, in its trace and timed
//   from it, as it no longer does: freed (`ok`), or left with the view (`aborted`, `close`). Told what holds them
//   however often, each is written once for each hold.
export function viewLog(log: Log) {
  // A decision is a unit of work that ends as it is taken.
  const decided = (event: string, facts: Facts, span: Span = startTrace()) => unitOfWork(log, event, facts, span).end({ outcome: "ok" });
  // [LAW:no-ambient-temporal-coupling] The hold in force, whose one owner this is: it begins it, and ends it as what
  // holds the moves changes or the view goes, on its own span.
  type Hold = { waiting: NonNullable<Waiting>; span: Span };
  let hold: Hold | undefined;
  const begun = (waiting: NonNullable<Waiting>): Hold => {
    const span = startTrace();
    decided("moves_held", waiting, span);
    return { waiting, span };
  };
  const free = (ending: Ending) => {
    if (hold !== undefined) unitOfWork(log, "moves_freed", hold.waiting, hold.span).end(ending);
    hold = undefined;
  };
  const same = (a: Waiting, b: Waiting) => (a === undefined || b === undefined ? a === b : sameFields(a, b));
  return {
    stepped: ({ cause, offset, end, kept, next }: StepTaken) => {
      if (next.replaced !== undefined) decided("place_replaced", { from: kept.position, to: next.position, why: next.replaced });
      if (kept.by === "view" && next.by === "reader") decided("reader_scroll", { from: kept.position, to: next.position, cause, offset, written: kept.written, end });
    },
    matchCleared: ({ key, why }: Gone & { key: string }) => decided("match_cleared", { key, why }),
    momentReplaced: (from: Moment, { why }: Gone<"read_ended">) => decided("moment_replaced", { from, why }),
    held: (waiting: Waiting) => {
      if (same(hold?.waiting, waiting)) return;
      free({ outcome: "ok" });
      hold = waiting === undefined ? undefined : begun(waiting);
    },
    close: () => free({ outcome: "aborted" }),
  };
}
