import { arrives, positionAt, resolve, type Placed, type Position } from "./position.ts";

// Where the rows are: a row's index by its key, a row by its index, the row at an offset, and whether the read can
// still bring the row at a key that is not among them (rows.ts, coming).
export type Rows = {
  indexOf: (key: string) => number | undefined;
  placed: (index: number) => Placed | undefined;
  rowAt: (offset: number) => Placed | undefined;
  coming: (key: string) => boolean;
};

// What the view keeps between steps: the position, and `written`, the offset it last wrote or took as its own. A
// scroller is created at 0, so 0 is where it starts.
export type Kept = { position: Position; written: number };

// What runs a step: a scroll event (`scroll`); a render, a resize or another change of what the step reads (`change`);
// or the reader choosing a position with the control (`choose`).
export type Cause = "scroll" | "change" | "choose";

// Who moved the position: the reader, by a scroll or a click, or the view, placing it as the layout changed.
export type By = "reader" | "view";

// [LAW:no-ambient-temporal-coupling] The view's one step between the scroller's offset and the position, run whatever
// the order its causes come in. Given the offset and the largest one, `end`, and whether the moment shown resumes
// following at the end (`resumable`, view/state.ts), it gives what to keep, the offset to write, if the position moved,
// and who moved it: the reader, or the view's own placing.
export function step(
  cause: Cause,
  offset: number,
  end: number,
  { position, written }: Kept,
  follow: boolean,
  resumable: boolean,
  rows: Rows,
): Kept & { write: number | undefined; by: By } {
  // [LAW:one-source-of-truth] The offset is the view's own when it is the one the view last wrote or took, or the end
  // the browser moved it to when the content got shorter or the scroller taller (a clamp). A clamp is the layout
  // changing, not a reader, so the position survives it. A reader's scroll reaches the end from below, so it is never a
  // clamp; any other offset is a reader's.
  // A position chosen with the control is the reader's latest act, so the offset under it is the view's own too, even
  // with a scroll whose event is still to come.
  const own = cause === "choose" || Math.abs(offset - Math.min(written, end)) < 1;
  // A reader's offset is the scroll event's to take: the virtualizer re-renders within that event, ahead of the view's
  // listener, and a clamp's event can come after a render, so a render that took an offset for the reader's could take
  // a clamp for a scroll. Until its event runs, a reader's offset is left as it is.
  const by: By = own ? "view" : "reader";
  if (!own && cause === "change") return { position, written, write: undefined, by };
  // A reader's offset becomes the position.
  const read = readAt(offset, end, follow, resumable, rows.rowAt);
  const kept = own && (position.at !== "end" || follow) ? position : read;
  // [LAW:one-source-of-truth] A place whose row will not arrive, the read having ended without it or the column showing
  // another history, is where the view is: it is not kept for the moves to count from.
  const next = kept.at === "row" && !arrives(kept.key, rows.indexOf, rows.coming) ? read : kept;
  // Resolved against where the rows now are, within reach, and written when it moved; a position whose row the read
  // can still bring, as after a reload, writes nothing until it arrives.
  const resolved = resolve(next, rows.indexOf, rows.placed);
  const target = resolved === undefined ? undefined : Math.min(resolved, end);
  return { position: next, written: offset, write: target === undefined || Math.abs(target - offset) < 1 ? undefined : target, by };
}

// The position a reader's offset reads as, by a scroll or a press on the minimap. Following, an offset within a pixel of
// the end is the end, for a moment that resumes there: a scroll to the end stays there and a scroll back to it resumes,
// and a gesture the browser stopped at an end that grew while it ran stays paused. The end while follow is off, or of a
// step chosen in time, is a place like any other, the one under the view: the view stays.
export function readAt(offset: number, end: number, follow: boolean, resumable: boolean, rowAt: Rows["rowAt"]): Position {
  return follow && resumable && end - offset < 1 ? { at: "end" } : positionAt(offset, rowAt);
}
