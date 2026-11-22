import { sameFields } from "./history.ts";
import { positionAt, resolve, type Placed, type Position, type Presence } from "./position.ts";
import type { Gone } from "./rows.ts";

// Where the rows are: where a position stands among them (position.ts `presence`), a row by its index, and the row at
// an offset.
export type Rows = {
  judge: (position: Position) => Presence;
  placed: (index: number) => Placed | undefined;
  rowAt: (offset: number) => Placed | undefined;
};

// What the view keeps between steps: the position, `written`, the offset it last wrote or took as its own, and `by`,
// whose the position is: the reader's, since they last moved it, or the view's, since it last placed or wrote it. A
// scroller is created at 0, the view's own, so 0 is where it starts.
export type Kept = { position: Position; written: number; by: By };

// What runs a step: a scroll event (`scroll`); a render, a resize or another change of what the step reads (`change`);
// or the reader choosing a position with the control (`choose`).
export type Cause = "scroll" | "change" | "choose";

// Who moved the position: the reader, by a scroll or a click, or the view, placing it as the layout changed.
export type By = "reader" | "view";

// Why the view gave a kept place up for the place under it: nothing will bring it (rows.ts `Gone`), or it was the end,
// which no longer follows.
export type GaveUp = Gone["why"] | "end_unfollowed";

// [LAW:types-are-the-program] What a step gives: what to keep, the offset to write, if any, and, when the view gave the
// kept place up for the place under it, which is then the view's, why.
export type Stepped = Kept & { write: number | undefined } & ({ replaced?: never } | { by: "view"; write: undefined; replaced: GaveUp });

// [LAW:no-ambient-temporal-coupling] The view's one step between the scroller's offset and the position, run whatever
// the order its causes come in. Given the offset and the largest one, `end`, and whether the moment shown resumes
// following at the end (`resumable`, view/state.ts), it gives what to keep and the offset to write. The position kept is
// the one it was given while the step leaves the place where it was.
export function step(cause: Cause, offset: number, end: number, kept: Kept, follow: boolean, resumable: boolean, rows: Rows): Stepped {
  const { position, written } = kept;
  // [LAW:one-source-of-truth] The offset is the view's own when it is the one the view last wrote or took, or the end
  // the browser moved it to when the content got shorter or the scroller taller (a clamp). A clamp is the layout
  // changing, not a reader, so the position survives it. A reader's scroll reaches the end from below, so it is never a
  // clamp; any other offset is a reader's.
  // A position chosen with the control is the reader's latest act, so the offset under it is the view's own too, even
  // with a scroll whose event is still to come.
  const own = cause === "choose" || Math.abs(offset - Math.min(written, end)) < 1;
  if (!own) {
    // A reader's offset is the scroll event's to take: the virtualizer re-renders within that event, ahead of the view's
    // listener, and a clamp's event can come after a render, so a render that took an offset for the reader's could take
    // a clamp for a scroll. Until its event runs, a reader's offset is left as it is.
    if (cause === "change") return { ...kept, write: undefined };
    // The place under the reader's offset is theirs, unless it is the place already kept.
    const under = readAt(offset, end, follow, resumable, rows.rowAt);
    return sameFields(under, position) ? { ...kept, written: offset, write: undefined } : { position: under, written: offset, write: undefined, by: "reader" };
  }
  // The position the step keeps, judged among the rows: the view's own, unless the end it holds no longer follows.
  const judged = position.at === "end" && !follow ? ({ at: "gone", why: "end_unfollowed" } as const) : rows.judge(position);
  // A kept place nothing will bring gives way to the place under the view, which is where the view already is, so
  // nothing is written.
  if (judged.at === "gone") return { position: readAt(offset, end, follow, resumable, rows.rowAt), written: offset, write: undefined, by: "view", replaced: judged.why };
  // A kept place is resolved against where the rows now are, within reach, and written when it moved; one not read yet,
  // or whose row is not placed yet, writes nothing until it is, so the moves wait for it.
  const resolved = resolve(judged, rows.placed);
  const target = resolved === undefined ? undefined : Math.min(resolved, end);
  const write = target === undefined || Math.abs(target - offset) < 1 ? undefined : target;
  return { position, written: offset, write, by: write === undefined ? kept.by : "view" };
}

// The position a reader's offset reads as, by a scroll or a press on the minimap. Following, an offset within a pixel of
// the end is the end, for a moment that resumes there: a scroll to the end stays there and a scroll back to it resumes,
// and a gesture the browser stopped at an end that grew while it ran stays paused. The end while follow is off, or of a
// step chosen in time, is a place like any other, the one under the view: the view stays.
export function readAt(offset: number, end: number, follow: boolean, resumable: boolean, rowAt: Rows["rowAt"]): Position {
  return follow && resumable && end - offset < 1 ? { at: "end" } : positionAt(offset, rowAt);
}
