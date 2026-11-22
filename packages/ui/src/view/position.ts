// Where the reader is in the conversation: at its end, wherever the end now is; at its start; or at a row, `offset`
// pixels into it at the top of the view.
// [LAW:types-are-the-program] A row is named by its key, not its pixel offset, which moves as rows above it arrive or
// are measured. The end is not a place: while follow is on, being at the end is following (docs/design/01-features.md, F4).
export type Position = { at: "end" } | { at: "start" } | { at: "row"; key: string; offset: number };

export type Direction = "next" | "previous";

// [LAW:types-are-the-program] Where a move from the reader's place starts (docs/design/02-design.md, "Keys"): the place
// itself, its row among the rows; `waiting` on the place, for a row the read has still to bring, as after a reload; or
// `view`, for a row that will not arrive, the read having ended without it or the column showing another history, so
// the reader is where the view shows, read off the scroller as the move is made.
export type Start = Position | { at: "waiting"; on: "place" } | { at: "view" };

// [LAW:single-enforcer] The one judge of whether the reader's place is among the rows: `toBeRead`, whether the read can
// still bring a key's row.
export function startOf(position: Position, indexOf: (key: string) => number | undefined, toBeRead: (key: string) => boolean): Start {
  if (position.at !== "row" || rowIndex(position.key, indexOf) !== undefined) return position;
  return toBeRead(position.key) ? { at: "waiting", on: "place" } : { at: "view" };
}

// The index of the row a move starts from, at `key`, among the rows `indexOf` lists (rowIndex). [LAW:no-silent-failure]
// A move is given a start found among the rows (startOf), so one that is not is a broken caller.
export function placeIndex(key: string, indexOf: (key: string) => number | undefined): number {
  const index = rowIndex(key, indexOf);
  if (index === undefined) throw new Error(`A move was given a start not among the rows: ${key}`);
  return index;
}

// A placed row: its key, where it starts, in pixels from the top of the conversation, and its height.
export type Placed = { key: string; start: number; size: number };

// The scroll offset a position is at, given where the rows are: undefined while its row is not among them. A row
// shorter than the offset into it, as a block just collapsed is, puts the view at its end. A row standing in for the
// position's own (rowIndex) puts the view at its end too, which is where the position's row stood. The end is past
// every offset: the largest one the scroller has is where the view shows it.
export function resolve(position: Position, indexOf: (key: string) => number | undefined, placed: (index: number) => Placed | undefined): number | undefined {
  switch (position.at) {
    case "end":
      return Infinity;
    case "start":
      return 0;
    case "row": {
      const index = rowIndex(position.key, indexOf);
      const row = index === undefined ? undefined : placed(index);
      return row === undefined ? undefined : row.start + Math.min(row.key === position.key ? position.offset : Infinity, row.size);
    }
  }
}

// The index of the row at `key`: its own, or, for a row a category hides, the row listed before it (Keys); or, while
// there is none, the nearest row it is inside: `a/b/c` is inside `a/b`, which is inside `a`. So a block the formatter
// replaced with the content it parsed from it, as it does a body so far, leaves the view at the block's group.
// Undefined while not even the outermost is among them, as after a reload before it is read.
export function rowIndex(key: string, indexOf: (key: string) => number | undefined): number | undefined {
  const index = indexOf(key);
  if (index !== undefined) return index;
  const cut = key.lastIndexOf("/");
  return cut === -1 ? undefined : rowIndex(key.slice(0, cut), indexOf);
}

// The place a scroll offset is at: the row at the top of the view and how far into it, or the start.
export function positionAt(offset: number, rowAt: (offset: number) => Placed | undefined): Exclude<Position, { at: "end" }> {
  const row = offset <= 0 ? undefined : rowAt(offset);
  return row === undefined ? { at: "start" } : { at: "row", key: row.key, offset: offset - row.start };
}
