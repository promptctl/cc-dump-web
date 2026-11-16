import type { Part } from "./parts.ts";

// A diff of two texts: what a change kept, removed and added, line by line, or within a line word by word.

export type Change = "same" | "removed" | "added";
// An edit: one line, or one word, and what the change did to it.
export type Edit = { change: Change; text: string };

// A diff as the view shows and searches it: its lines; their text in order, joined by newlines; and each line's passage
// of that text, its start and end, so a match is found within one line and painted where that line is.
export type Diff = { lines: Edit[] } & Joined;
export type Joined = { text: string; passages: { start: number; end: number }[] };

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
export function joined(lines: string[]): Joined {
  let start = 0;
  const passages = lines.map((line) => {
    const passage = { start, end: start + line.length };
    start = passage.end + 1;
    return passage;
  });
  return { text: lines.join("\n"), passages };
}

// How many unchanged lines a diff lists beside a change, above and below it: its context lines; and as many unchanged
// rows beside a changed one in the conversation.
export const context = 3;

// [LAW:one-source-of-truth] How a unified diff marks a line, by what the change did to it.
export const marks: Record<Change, string> = { same: " ", removed: "-", added: "+" };

// The lines `before` became `after` by. A line is the text between newlines, verbatim; an empty text has none.
export function lineDiff(before: string, after: string): Edit[] {
  return diff(linesOf(before), linesOf(after));
}
const linesOf = (text: string) => (text === "" ? [] : text.split("\n"));

// The words a line `before` became `after` by, each run of what the change did to them joined into one edit. A word is
// a segment between Unicode word boundaries (UAX #29): a word, a run of spaces, or a punctuation mark, so a changed word
// is marked without the spaces and punctuation around it, and no character a reader sees as one is cut.
export function wordDiff(before: string, after: string): Edit[] {
  return diff(wordsOf(before), wordsOf(after)).reduce<Edit[]>((joined, edit) => {
    const last = joined.at(-1);
    if (last?.change === edit.change) joined[joined.length - 1] = { change: edit.change, text: last.text + edit.text };
    else joined.push(edit);
    return joined;
  }, []);
}
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const wordsOf = (text: string) => Array.from(words.segment(text), ({ segment }) => segment);

// The items `a` became `b` by, in order: the items both start and end with kept, and between them a shortest edit
// script, by Myers' O(ND) greedy algorithm ("An O(ND) Difference Algorithm and Its Variations", 1986), so a change of a
// few items in a long sequence costs those few. Where an item was removed and another added, the removal comes first.
function diff(a: string[], b: string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const same = (text: string): Edit => ({ change: "same", text });
  return [...a.slice(0, start).map(same), ...middle(a.slice(start, a.length - end), b.slice(start, b.length - end)), ...a.slice(a.length - end).map(same)];
}

// The most edits a shortest script is searched to: its trace holds about this many squared positions. A change of more
// is shown as every item of the one sequence removed and every item of the other added, a script still, only not the shortest.
const editLimit = 1000;

function middle(a: string[], b: string[]): Edit[] {
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
  return [...a.map((text): Edit => ({ change: "removed", text })), ...b.map((text): Edit => ({ change: "added", text }))];
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
