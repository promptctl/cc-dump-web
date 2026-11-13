import { positionAt, resolve, type Placed, type Position } from "./position.ts";

// Where the rows are: a row's index by its key, a row by its index, and the row at an offset.
export type Rows = {
  indexOf: (key: string) => number | undefined;
  placed: (index: number) => Placed | undefined;
  rowAt: (offset: number) => Placed | undefined;
};

// What the view keeps between steps: the position, and `written`, the offset it last wrote or took as its own. A
// scroller is created at 0, so 0 is where it starts.
export type Kept = { position: Position; written: number };

// [LAW:no-ambient-temporal-coupling] The view's one step between the scroller's offset and the position, run on every
// scroll event (`scroll`) and after every render or change of the stores (`change`), in whatever order they come. Given
// the offset and the largest one, `end`, it gives what to keep and the offset to write, if the position moved.
export function step(
  cause: "scroll" | "change",
  offset: number,
  end: number,
  { position, written }: Kept,
  follow: boolean,
  rows: Rows,
): Kept & { write: number | undefined } {
  // [LAW:one-source-of-truth] The offset is the view's own when it is the one the view last wrote or took, or the end
  // the browser moved it to when the content got shorter or the scroller taller (a clamp). A clamp is the layout
  // changing, not a reader, so the position survives it. A reader's scroll reaches the end from below, so it is never a
  // clamp; any other offset is a reader's.
  const own = Math.abs(offset - Math.min(written, end)) < 1;
  // A reader's offset is the scroll event's to take: the virtualizer re-renders within that event, ahead of the view's
  // listener, and a clamp's event can come after a render, so a render that took an offset for the reader's could take
  // a clamp for a scroll. Until its event runs, a reader's offset is left as it is.
  if (!own && cause === "change") return { position, written, write: undefined };
  // The position is read from the offset when a reader moved it: following, a scroll to the end stays at the end and a
  // scroll back to it resumes, and a gesture the browser stopped at an end that grew while it ran stays paused. It is
  // read from the offset too when it is the end while follow is off, which is a place like any other: the view stays.
  const next = own && (position.at !== "end" || follow) ? position : positionAt(offset, follow ? end : undefined, rows.rowAt);
  // Resolved against where the rows now are, and written when it moved; a position whose row has not arrived, as after
  // a reload, writes nothing until it does.
  const target = resolve(next, end, rows.indexOf, rows.placed);
  return { position: next, written: offset, write: target === undefined || Math.abs(target - offset) < 1 ? undefined : target };
}
