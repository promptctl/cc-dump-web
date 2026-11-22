import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import type { Ending } from "@cc-dump/log/ending";
import { decided as decide, unitOfWork } from "../log.ts";
import type { Cleared, Waiting } from "./moves.ts";
import type { Gone } from "./rows.ts";
import type { Cause, Kept, Stepped } from "./scroll.ts";
import type { Moment } from "./state.ts";

// A step the view took (scroll.ts `step`), as its decisions read it: what it was given and what it gave.
export type StepTaken = { cause: Cause; offset: number; end: number; kept: Kept; next: Stepped };

// [LAW:single-enforcer] [LAW:nothing-unseen] The view's decisions about the reader's view, each written to `log` as an
// event of its own, in the parts' shape, with the facts that decided it, so a place that moved says what moved it:
// - `place_replaced`: the view gave the kept place up for the place under it, and why (scroll.ts `GaveUp`).
// - `reader_scroll`: the view took an offset for the reader's, where it had last written or placed the place, so the
//   place became the one under it, with the offset, the one the view last wrote or took, and the end, which tell a
//   scroll from a clamp. Once for each run of the reader's scrolls (scroll.ts `Kept`).
// - `match_cleared`: the current match is none, where it was, the pattern it was taken under and the one the search
//   reads now, and why (moves.ts `Cleared`): nothing will bring its
//   row, as a step's `why` says; `pattern_changed`, the query or how it is read changed, here or in another tab;
//   `text_gone`, its block no longer shows a text at its address; `text_changed`, its text holds fewer of the pattern's
//   matches than the one it was.
// - `moment_replaced`: the moment shown is one the read ended without, and now's is shown instead.
// - `moves_held` as a place or a match not read yet begins to hold the moves, and `moves_freed`, in its trace and timed
//   from it, with how the read it waited on stood last, as it no longer does: freed (`ok`), or left with the view
//   (`aborted`, `close`). Told what holds them however often, each is written once for each hold.
export function viewLog(log: Log) {
  // Every decision here ends as taken.
  const decided = (event: string, facts: Facts, span?: Span) => decide(log, event, facts, { outcome: "ok" }, span);
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
  return {
    stepped: ({ cause, offset, end, kept, next }: StepTaken) => {
      if (next.replaced !== undefined) decided("place_replaced", { from: kept.position, to: next.position, why: next.replaced });
      if (!kept.scrolled && next.scrolled) decided("reader_scroll", { from: kept.position, to: next.position, cause, offset, written: kept.written, end });
    },
    matchCleared: ({ key, at, nth, why, pattern, searching }: Cleared) => decided("match_cleared", { key, at, nth, why, pattern, searching }),
    momentReplaced: (from: Moment, { why }: Gone<"read_ended">) => decided("moment_replaced", { from, why }),
    // A hold is of what holds the moves, the place or the match: the read it waits on may fail during it, which leaves
    // the moves held, so the hold goes on, and its end says how the read stood last.
    held: (waiting: Waiting) => {
      const same = hold?.waiting.held === waiting?.held;
      if (!same) free({ outcome: "ok" });
      hold = waiting === undefined ? undefined : same && hold !== undefined ? { ...hold, waiting } : begun(waiting);
    },
    close: () => free({ outcome: "aborted" }),
  };
}
