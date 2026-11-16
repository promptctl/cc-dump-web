// A line diff of two texts: what a change kept, removed and added, line by line.

export type Change = "same" | "removed" | "added";
export type DiffLine = { change: Change; text: string };

// The lines `before` became `after` by, in order: a shortest edit script, by Myers' O(ND) greedy algorithm ("An O(ND)
// Difference Algorithm and Its Variations", 1986), so a change of a few lines in a long text costs those few. Where a
// line was removed and another added, the removal comes first. A line is the text between newlines, verbatim.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // `v[k + offset]`: the furthest x reached on diagonal k = x - y; `trace[d]`: v as it stood before edit d.
  const offset = a.length + b.length;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= offset; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!);
      let x = down ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[k + offset] = x;
      if (x >= a.length && y >= b.length) return script(trace, offset, a, b);
    }
  }
  throw new Error("unreachable: an edit script is at most every line of both texts");
}

// The edit script the trace holds, walked back from the end to the start.
function script(trace: Int32Array[], offset: number, a: string[], b: string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  let [x, y] = [a.length, b.length];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!);
    const previousK = down ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : v[previousK + offset]!;
    const previousY = d === 0 ? 0 : previousX - previousK;
    for (; x > previousX && y > previousY; x--, y--) lines.push({ change: "same", text: a[x - 1]! });
    if (d > 0) lines.push(down ? { change: "added", text: b[--y]! } : { change: "removed", text: a[--x]! });
  }
  return lines.reverse();
}
