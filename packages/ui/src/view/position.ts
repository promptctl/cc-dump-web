import type { Keys, MomentStanding, Unread } from "./rows.ts";

// Where the reader is in the conversation: at its end, wherever the end now is; at its start; or at a row, `offset`
// pixels into it at the top of the view.
// [LAW:types-are-the-program] A row is named by its key, not its pixel offset, which moves as rows above it arrive or
// are measured. The end is not a place: while follow is on, being at the end is following (docs/design/01-features.md, F4).
export type Position = { at: "end" } | { at: "start" } | { at: "row"; key: string; offset: number };

// A placed row: its key, where it starts, in pixels from the top of the conversation, and its height.
export type Placed = { key: string; start: number; size: number };

// Where a position stands among a column's rows, in the order of the `Keys` it was judged in: before them all, after
// them all, at the row at `index`, `offset` pixels into it, or `past` it, at the end of the row standing in for the
// position's own. `pending`: its row is not among them, and the read (`read`) can still bring it. `gone`: it is not,
// and nothing will bring it.
// [LAW:types-are-the-program] A move counts from an `At` alone, so no move reads a place that is not among the rows.
export type At = { at: "start" } | { at: "end" } | { at: "row"; index: number; offset: number } | { at: "past"; index: number };
export type Presence = At | Unread;

// [LAW:single-enforcer] The one judgement of where a position stands among the rows `keys` order, which every move, the
// scroll step and the line that says a place is not read yet ask. A row's key stands where its row does, if the row is
// among `every` row, listed or not: at its own row, or, for a row a category, a closed set or a closed nest hides, at
// the row listed before it (Keys), or before them all when none is. Otherwise it stands where the nearest row it is
// inside does: `a/b/c` is inside `a/b`, which is inside `a`, so a block the formatter replaced, as it replaces a request
// body so far, stands at its group, and a fork's line still to come at the row it will follow. Inside none, it is
// pending while what can still bring it does (rows.ts, MomentStanding), and gone otherwise. A reader's place is a moment
// and a place in its column, so every position stands as its moment does while that is not read, or gone.
export function presence(position: Position, keys: Keys, every: Keys["indexOf"], moment: MomentStanding): Presence {
  if (moment.at !== "read") return moment;
  if (position.at !== "row") return position;
  const { key, offset } = position;
  const inside = insideOf(key, every);
  if (inside === undefined) return moment.pending(key);
  const index = keys.indexOf(inside);
  return index === undefined ? { at: "start" } : keys.at(index) === key ? { at: "row", index, offset } : { at: "past", index };
}

// The key itself, or the longest of its prefixes cut at a slash, that is among the rows; undefined when none is. The
// walk ends on every key: each cut is shorter than the key before it.
function insideOf(key: string, indexOf: Keys["indexOf"]): string | undefined {
  for (let at = key; ; at = at.slice(0, at.lastIndexOf("/"))) {
    if (indexOf(at) !== undefined) return at;
    if (!at.includes("/")) return undefined;
  }
}

// [LAW:one-source-of-truth] Where a place stands in the order of the rows it was judged in, as a number their indexes
// compare with. `rankOf`, against where the rows start: before them all, after them all, a row's index at its very
// start, and half a row on some way into it or past it, so the row's start is behind it. `rankBefore`, against what
// the rows hold: a place at a row, however far into it, is just before it, so all the row holds is ahead, as the search
// counts the matches of the row at the view's top.
export const rankOf = (at: At): number => (at.at === "start" ? -Infinity : at.at === "end" ? Infinity : at.at === "row" && at.offset === 0 ? at.index : at.index + 0.5);
export const rankBefore = (at: At): number => (at.at === "row" ? at.index - 0.5 : rankOf(at));

// The scroll offset a position is at, given where the rows are: undefined while it is not among them, or its row is not
// placed yet. A row shorter than the offset into it, as a block just collapsed is, puts the view at its end, as a place
// past the row standing in for it does. The end is past every offset: the largest one the scroller has is where the
// view shows it.
export function resolve(at: Presence, placed: (index: number) => Placed | undefined): number | undefined {
  switch (at.at) {
    case "end":
      return Infinity;
    case "start":
      return 0;
    case "row":
    case "past": {
      const row = placed(at.index);
      return row === undefined ? undefined : row.start + (at.at === "row" ? Math.min(at.offset, row.size) : row.size);
    }
    case "pending":
    case "gone":
      return undefined;
  }
}

// The place a scroll offset is at: the row at the top of the view and how far into it, or the start.
export function positionAt(offset: number, rowAt: (offset: number) => Placed | undefined): Exclude<Position, { at: "end" }> {
  const row = offset <= 0 ? undefined : rowAt(offset);
  return row === undefined ? { at: "start" } : { at: "row", key: row.key, offset: offset - row.start };
}
