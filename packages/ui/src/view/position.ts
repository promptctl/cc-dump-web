// Where the reader is in the conversation: at its start, or at a row, `offset` pixels into it at the top of the view.
// [LAW:types-are-the-program] A row is named by its key, not its pixel offset, which moves as rows above it arrive or
// are measured.
export type Position = { at: "start" } | { at: "row"; key: string; offset: number };

// A placed row: its key, where it starts, in pixels from the top of the conversation, and its height.
export type Placed = { key: string | number | bigint; start: number; size: number };

// The scroll offset a position is at, given where the rows are: undefined while its row is not among them. A row
// shorter than the offset into it, as a block just collapsed is, puts the view at its end.
export function resolve(position: Position, indexOf: (key: string) => number | undefined, placed: (index: number) => Placed | undefined): number | undefined {
  switch (position.at) {
    case "start":
      return 0;
    case "row": {
      const index = rowIndex(position.key, indexOf);
      const row = index === undefined ? undefined : placed(index);
      return row === undefined ? undefined : row.start + Math.min(position.offset, row.size);
    }
  }
}

// The index of the row with `key`, or, while it is not among the rows, of the nearest row it is inside: `a/b/c` is
// inside `a/b`, which is inside `a`. A block the formatter replaced, as a body so far is by the content parsed from it,
// leaves the view at its group. Undefined while not even the outermost is among them, as after a reload before it is read.
export function rowIndex(key: string, indexOf: (key: string) => number | undefined): number | undefined {
  for (let end = key.length; end !== -1; end = key.lastIndexOf("/", end - 1)) {
    const index = indexOf(key.slice(0, end));
    if (index !== undefined) return index;
  }
  return undefined;
}

// The position a scroll offset is at: the row at the top of the view and how far into it, or the start.
export function positionAt(offset: number, rowAt: (offset: number) => Placed | undefined): Position {
  const row = offset <= 0 ? undefined : rowAt(offset);
  return row === undefined ? { at: "start" } : { at: "row", key: String(row.key), offset: offset - row.start };
}
