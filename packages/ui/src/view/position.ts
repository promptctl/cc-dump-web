// Where the reader is in the conversation: at its end, wherever the end now is; at its start; or at a row, `offset`
// pixels into it at the top of the view.
// [LAW:types-are-the-program] A row is named by its key, not its pixel offset, which moves as rows above it arrive or
// are measured. The end is not a place: while follow is on, being at the end is following (docs/design/01-features.md, F4).
export type Position = { at: "end" } | { at: "start" } | { at: "row"; key: string; offset: number };

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

export type Direction = "next" | "previous";

// [LAW:one-source-of-truth] Where a move counts from, on the one axis every move compares on: before every row, a row's
// top, some way into it, its bottom, just after it, and after every row. A row a category hides, or one the formatter
// replaced, stands just after the row standing in for it (rowIndex), which is where the view is (resolve).
// [LAW:parse-dont-validate] Made only here, from a place found among the rows, so a move given one never meets a row
// that is not among them.
export type Slot = number & { readonly slot: unique symbol };
const slot = (at: number) => at as Slot;
export const beforeAll = slot(-1);
export const afterAll = slot(Infinity);
export const top = (index: number) => slot(4 * index);
const inside = (index: number) => slot(4 * index + 1);
export const bottom = (index: number) => slot(4 * index + 2);
const after = (index: number) => slot(4 * index + 3);

// [LAW:types-are-the-program] Where a move from a place starts: its slot, or a wait, while its row is not among the
// rows. A row that will not arrive is never stored (scroll.ts, state.ts), so a missing row is one the read can still
// bring, as after a reload.
export type Start = { at: "slot"; slot: Slot } | { at: "waiting" };

// [LAW:single-enforcer] The one judge of where a move from `position` starts among the rows `keys` lists.
export function startAt(position: Position, keys: { at: (index: number) => string; indexOf: (key: string) => number | undefined }): Start {
  const at = (slot: Slot): Start => ({ at: "slot", slot });
  switch (position.at) {
    case "start":
      return at(beforeAll);
    case "end":
      return at(afterAll);
    case "row": {
      const index = rowIndex(position.key, keys.indexOf);
      if (index === undefined) return { at: "waiting" };
      return at(keys.at(index) !== position.key ? after(index) : position.offset > 0 ? inside(index) : top(index));
    }
  }
}

// A move from `start`: none while it waits.
export const fromStart = <T>(start: Start, move: (from: Slot) => T): T | undefined => (start.at === "waiting" ? undefined : move(start.slot));

// Whether the row at `key` is among the rows, or one the read can still bring (`coming`, rows.ts): a stored place or
// current match that does neither will not arrive.
export const arrives = (key: string, indexOf: (key: string) => number | undefined, coming: (key: string) => boolean): boolean =>
  rowIndex(key, indexOf) !== undefined || coming(key);

// What the line under the rows says of the starts the moves wait on: the reader's place, which every move counts from,
// and the current match, which the search's steps count from. Empty while neither waits.
export function waitingLine(place: Start, match: Start | undefined): string {
  if (place.at === "waiting") return "Your place is still being read";
  return match?.at === "waiting" ? "The current match is still being read" : "";
}

// The place a scroll offset is at: the row at the top of the view and how far into it, or the start.
export function positionAt(offset: number, rowAt: (offset: number) => Placed | undefined): Exclude<Position, { at: "end" }> {
  const row = offset <= 0 ? undefined : rowAt(offset);
  return row === undefined ? { at: "start" } : { at: "row", key: row.key, offset: offset - row.start };
}
