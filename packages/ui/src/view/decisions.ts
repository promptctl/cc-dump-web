import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import type { TraceId } from "@cc-dump/log/trace";
import { loggedAfter, unitOfWork } from "../log.ts";
import type { Waiting } from "./moves.ts";
import type { Position } from "./position.ts";
import type { Gone } from "./rows.ts";
import type { By, Cause, GaveUp, Kept } from "./scroll.ts";
import type { Moment } from "./state.ts";

// A step the view took (scroll.ts `step`), as its decisions read it: what it was given and what it gave.
export type Stepped = { cause: Cause; offset: number; end: number; kept: Kept; next: { position: Position; write: number | undefined; by: By; replaced: GaveUp | undefined } };

// [LAW:single-enforcer] [LAW:nothing-unseen] The view's decisions about the reader's view, each written to `log` as an
// event of its own, in the parts' shape, with the facts that decided it, so a place that moved says what moved it:
// - `place_replaced`: the view gave the kept place up for the place under it, and why (scroll.ts `GaveUp`).
// - `reader_scroll`: the view took an offset for the reader's, so the place became the one under it, with the offset,
//   the one the view last wrote or took, and the end, which tell a scroll from a clamp. Once for each run of the
//   reader's scrolls: the view's next write or placing ends the run.
// - `match_cleared`: the current match is one nothing will bring, and why.
// - `moment_replaced`: the moment shown is one the read ended without, and now's is shown instead.
// - `moves_held` as a place or a match not read yet begins to hold the moves, and `moves_freed`, timed from it in its
//   trace, as it no longer does. Told what holds them however often, each is written once for each hold.
// `clock` is the page's monotonic clock, in milliseconds.
export function viewLog(log: Log, clock: () => number) {
  // A decision is a unit of work that ends as it is taken.
  const decided = (event: string, facts: Facts, span: Span = startTrace()) => unitOfWork(log, event, facts, span).end({ outcome: "ok" });
  // Whether the place has been the reader's since the view last wrote or placed it.
  let reader = false;
  type Hold = { waiting: NonNullable<Waiting>; trace_id: TraceId; since: number };
  let hold: Hold | undefined;
  const begun = (waiting: NonNullable<Waiting>): Hold => {
    const span = startTrace();
    decided("moves_held", waiting, span);
    return { waiting, trace_id: span.trace_id, since: clock() };
  };
  return {
    stepped: ({ cause, offset, end, kept, next }: Stepped) => {
      const moved = next.position !== kept.position;
      if (next.replaced !== undefined) decided("place_replaced", { from: kept.position, to: next.position, why: next.replaced });
      if (next.by === "reader" && moved && !reader) decided("reader_scroll", { from: kept.position, to: next.position, cause, offset, written: kept.written, end });
      reader = next.by === "reader" ? reader || moved : reader && !moved && next.write === undefined;
    },
    matchCleared: ({ key, why }: Gone & { key: string }) => decided("match_cleared", { key, why }),
    momentReplaced: (from: Moment, { why }: Gone) => decided("moment_replaced", { from, why }),
    held: (waiting: Waiting) => {
      if (hold?.waiting.held === waiting?.held && hold?.waiting.read === waiting?.read) return;
      if (hold !== undefined) loggedAfter(log, hold.trace_id, "moves_freed", hold.waiting, clock() - hold.since, { outcome: "ok" });
      hold = waiting === undefined ? undefined : begun(waiting);
    },
  };
}
