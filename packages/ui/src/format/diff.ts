import type { Part } from "./parts.ts";

// A diff of two texts: what a change kept, removed and added, line by line, or within a line word by word.

export type Change = "same" | "removed" | "added";
// An edit: one line, or one word, and what the change did to it.
export type Edit = { change: Change; text: string };

// A diff as the view shows and searches it: its lines; their text in order, joined by newlines; and each line's passage
// of that text, its start and end, so a match is found within one line and painted where that line is.
export type Diff = { lines: Edit[] } & Joined;
type Joined = { text: string; passages: { start: number; end: number }[] };

// [LAW:one-source-of-truth] A diff part holds the two texts; its lines are derived from them, made once per part, and
// only for a part that is shown or searched, so a session's Edits are not diffed again by every request that resends them.
const diffs = new WeakMap<Extract<Part, { kind: "diff" }>, Diff>();
export function diffOf(part: Extract<Part, { kind: "diff" }>): Diff {
  const made = diffs.get(part);
  if (made !== undefined) return made;
  const lines = lineDiff(part.before, part.after);
  const shown = { lines, ...joined(lines.map(({ text }) => text)) };
  diffs.set(part, shown);
  return shown;
}

// Lines as one text, joined by newlines, and each line's passage of it.
function joined(lines: string[]): Joined {
  let start = 0;
  const passages = lines.map((line) => {
    const passage = { start, end: start + line.length };
    start = passage.end + 1;
    return passage;
  });
  return { text: lines.join("\n"), passages };
}

// How many unchanged lines a diff lists beside a change, above and below it: its context lines.
const context = 3;

// [LAW:one-source-of-truth] Whether each item, of items each changed or not, is further than `context` items from every
// change, above it and below it: what a diff folds.
export function beyondContext(changed: boolean[]): boolean[] {
  const distances = (order: number[]) => {
    const distance: number[] = [];
    let since = Infinity;
    for (const index of order) distance[index] = since = changed[index] ? 0 : since + 1;
    return distance;
  };
  const places = changed.map((_, index) => index);
  const above = distances(places);
  const below = distances(places.toReversed());
  return places.map((index) => above[index]! > context && below[index]! > context);
}

// [LAW:one-source-of-truth] How a unified diff marks a line, by what the change did to it.
export const marks: Record<Change, string> = { same: " ", removed: "-", added: "+" };

// The lines `before` became `after` by. A line is the text between newlines, verbatim; an empty text has none.
export function lineDiff(before: string, after: string): Edit[] {
  return diff(linesOf(before), linesOf(after));
}
const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

// The words a line `before` became `after` by, each run of what the change did to them joined into one edit. A word is
// a segment between Unicode word boundaries (UAX #29): a word, a run of spaces, or a punctuation mark, so a changed word
// is marked without the spaces and punctuation around it, and no character a reader sees as one is cut. The boundaries
// are the root locale's, so a line splits the same on every machine.
export function wordDiff(before: string, after: string): Edit[] {
  return diff(wordsOf(before), wordsOf(after)).reduce<Edit[]>((joined, edit) => {
    const last = joined.at(-1);
    if (last?.change === edit.change) joined[joined.length - 1] = { change: edit.change, text: last.text + edit.text };
    else joined.push(edit);
    return joined;
  }, []);
}
const words = new Intl.Segmenter("und", { granularity: "word" });
const wordsOf = (text: string) => Array.from(words.segment(text), ({ segment }) => segment);

// Where the characters of `before` from `start` up to `end` went in `after`, the text it became, as an editor carries a
// cursor through an edit: `kept`, the places in `after` of those a shortest edit script between the two kept, none for
// those it removed; or `rewritten`, when they are in a change of more edits than a shortest script is searched to, so
// which of them it kept is not known.
export type Carried = { at: "kept"; places: number[] } | { at: "rewritten" };

export function carriedTo(before: string, after: string, { start, end }: { start: number; end: number }): Carried {
  const { head, tail } = endsOf(before, after);
  const changedEnd = before.length - tail;
  const edits = middle(before.slice(head, changedEnd).split(""), after.slice(head, after.length - tail).split(""));
  if (edits === undefined && start < changedEnd && end > head) return { at: "rewritten" };
  const places: number[] = [];
  // [LAW:dataflow-not-control-flow] Each character is in the start both texts share, in the changed middle, or in the
  // end both share, and each run of them is walked whatever the span holds: a run outside the span adds no place. A
  // middle past the limit holds none of the span, as the span in it is `rewritten`, so it has no edits to walk.
  for (let at = start; at < Math.min(end, head); at++) places.push(at);
  let [from, to] = [head, head];
  for (const { change } of edits ?? []) {
    if (change === "same" && from >= start && from < end) places.push(to);
    if (change !== "added") from++;
    if (change !== "removed") to++;
  }
  for (let at = Math.max(start, changedEnd); at < end; at++) places.push(at + after.length - before.length);
  return { at: "kept", places };
}

// How many items `a` and `b` start with alike, `head`, and then end with alike, `tail`: what an edit script keeps
// without searching.
function endsOf(a: ArrayLike<string>, b: ArrayLike<string>): { head: number; tail: number } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
}

// The items `a` became `b` by, in order: the items both start and end with kept, and between them a shortest edit
// script, by Myers' O(ND) greedy algorithm ("An O(ND) Difference Algorithm and Its Variations", 1986), so a change of a
// few items in a long sequence costs those few. Where an item was removed and another added, the removal comes first.
// A change of more edits than a shortest script is searched to is shown as every item of the one removed and every item
// of the other added, a script still, only not the shortest.
function diff(a: string[], b: string[]): Edit[] {
  const { head, tail } = endsOf(a, b);
  const [changedA, changedB] = [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
  const same = (text: string): Edit => ({ change: "same", text });
  const replaced = () => [...changedA.map((text): Edit => ({ change: "removed", text })), ...changedB.map((text): Edit => ({ change: "added", text }))];
  return [...a.slice(0, head).map(same), ...(middle(changedA, changedB) ?? replaced()), ...a.slice(a.length - tail).map(same)];
}

// The most edits a shortest script is searched to: its trace holds about this many squared positions.
const editLimit = 1000;

// A shortest edit script from `a` to `b`, none past `editLimit` edits.
function middle(a: string[], b: string[]): Edit[] | undefined {
  // `v[k + offset]`: the furthest x reached on diagonal k = x - y; `trace[d]`: v's diagonals -d..d before edit d.
  const offset = a.length + b.length;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(offset, editLimit); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!);
      let x = down ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[k + offset] = x;
      if (x >= a.length && y >= b.length) return script(trace, a, b);
    }
  }
  return undefined;
}

// The edit script the trace holds, walked back from the end to the start.
function script(trace: Int32Array[], a: string[], b: string[]): Edit[] {
  const lines: Edit[] = [];
  let [x, y] = [a.length, b.length];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const at = (k: number) => v[k + d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = d === 0 ? 0 : previousX - previousK;
    for (; x > previousX && y > previousY; x--, y--) lines.push({ change: "same", text: a[x - 1]! });
    if (d > 0) lines.push(down ? { change: "added", text: b[--y]! } : { change: "removed", text: a[--x]! });
  }
  return lines.reverse();
}
