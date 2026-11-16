import type { Block } from "../format/blocks.ts";
import { diffOf, lineDiff, wordDiff, type Edit } from "../format/diff.ts";
import { fieldLines, type Part } from "../format/parts.ts";
import type { Folded } from "./rendering.ts";
import { context, jsonText } from "./rows.ts";

// What changed in a block between two moments (docs/design/02-design.md, "Two axes"): the two versions as a side-by-side
// diff, line against line, unchanged lines level, changed lines marked word by word, a line only one side has against an
// empty slot on the other, and runs of unchanged lines folded as the conversation's unchanged rows are.

// A line on one side: where it is among its side's lines, and its words, each marked for what the change did to it.
export type SideLine = { line: number; words: Edit[] };

// [LAW:types-are-the-program] Two lines side by side: one kept on both sides, one replaced by another, or a line only
// one side has, against an empty slot.
export type Pair =
  | { kind: "same" | "replaced"; left: SideLine; right: SideLine }
  | { kind: "removed"; left: SideLine; right: undefined }
  | { kind: "added"; left: undefined; right: SideLine };

// A run of unchanged pairs folded into one line, named by the place of its first among the pairs.
export type LineFold = { kind: "fold"; at: number; pairs: Pair[] };

// A block's diff: its pairs in order with the unchanged runs folded; and the right side's text, the later version's, as
// the search reads it: each line a passage, and the characters of each fold.
export type BlockDiff = { entries: (Pair | LineFold)[]; right: Folded };

// [LAW:one-source-of-truth] A block as one text, so every kind of block is compared one way: its parts in order, a blank
// line between them; a text as written, JSON as formatted, a field a line of its own, `name: value`, indented under the
// field holding it, a diff its lines as a unified diff writes them, and media what it is. Labels are the view's words,
// not the block's.
export function blockText(block: Block): string {
  return block.parts.map(partText).join("\n\n");
}

function partText(part: Part): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "json":
      return jsonText(part);
    case "fields":
      return fieldLines(part.fields)
        .map(({ name, value, depth }) => `${"  ".repeat(depth)}${name}:${value === undefined ? "" : ` ${value}`}`)
        .join("\n");
    case "diff":
      return diffOf(part)
        .lines.map(({ change, text }) => `${marks[change]}${text}`)
        .join("\n");
    case "media": {
      const { of, source } = part;
      switch (source.type) {
        case "base64":
          return `[${of}: ${source.media_type}, ${source.data.length} characters of base64]`;
        case "url":
          return `[${of}: ${source.url}]`;
        case "file":
          return `[${of}: file ${source.file_id}]`;
      }
    }
  }
}
const marks: Record<Edit["change"], string> = { same: " ", removed: "-", added: "+" };

// [LAW:one-source-of-truth] Each pair of versions is diffed once, when it is first shown or searched, so neither a frame
// nor a search that reads it again pays for it again.
const diffs = new WeakMap<Block, WeakMap<Block, BlockDiff>>();
export function blockDiff(before: Block, after: Block): BlockDiff {
  const afters = diffs.get(before) ?? new WeakMap<Block, BlockDiff>();
  diffs.set(before, afters);
  const made = afters.get(after) ?? diffOfTexts(blockText(before), blockText(after));
  afters.set(after, made);
  return made;
}

function diffOfTexts(before: string, after: string): BlockDiff {
  const pairs = pairsOf(lineDiff(before, after));
  const entries = folded(pairs);
  const lines = pairs.flatMap(({ right }) => (right === undefined ? [] : [right]));
  let start = 0;
  const passages = lines.map(({ words }) => {
    const length = words.reduce((sum, { text }) => sum + text.length, 0);
    const passage = { start, end: start + length };
    start = passage.end + 1;
    return passage;
  });
  const folds = entries.flatMap((entry) => {
    if (entry.kind !== "fold") return [];
    const first = passages[entry.pairs[0]!.right!.line]!;
    const last = passages[entry.pairs.at(-1)!.right!.line]!;
    return [{ start: first.start, end: last.end, line: entry.at }];
  });
  return { entries, right: { text: lines.map(({ words }) => words.map(({ text }) => text).join("")).join("\n"), passages, folds } };
}

// The lines side by side: a kept line against itself; and in each run of changes, the lines removed against the lines
// added, in order, each pair marked word by word, and the lines one side has more of against empty slots.
function pairsOf(edits: Edit[]): Pair[] {
  const pairs: Pair[] = [];
  let left = 0;
  let right = 0;
  for (let at = 0; at < edits.length; ) {
    const edit = edits[at]!;
    if (edit.change === "same") {
      const words = [edit];
      pairs.push({ kind: "same", left: { line: left++, words }, right: { line: right++, words } });
      at++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    for (; at < edits.length && edits[at]!.change !== "same"; at++) (edits[at]!.change === "removed" ? removed : added).push(edits[at]!.text);
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const [was, is] = [removed[index], added[index]];
      if (was !== undefined && is !== undefined) {
        const words = wordDiff(was, is);
        pairs.push({
          kind: "replaced",
          left: { line: left++, words: words.filter(({ change }) => change !== "added") },
          right: { line: right++, words: words.filter(({ change }) => change !== "removed") },
        });
      } else if (was !== undefined) pairs.push({ kind: "removed", left: { line: left++, words: [{ change: "removed", text: was }] }, right: undefined });
      else pairs.push({ kind: "added", left: undefined, right: { line: right++, words: [{ change: "added", text: is! }] } });
    }
  }
  return pairs;
}

// The pairs with each run of unchanged ones folded, beyond `context` pairs beside a change, as the conversation folds
// its unchanged rows; a run of one is listed, since its fold would take the line it saves.
function folded(pairs: Pair[]): (Pair | LineFold)[] {
  const distance = (order: number[]) => {
    const distances: number[] = [];
    let since = Infinity;
    for (const index of order) {
      since = pairs[index]!.kind === "same" ? since + 1 : 0;
      distances[index] = since;
    }
    return distances;
  };
  const places = pairs.map((_, index) => index);
  const above = distance(places);
  const below = distance(places.toReversed());
  const folds = (index: number) => above[index]! > context && below[index]! > context;
  const entries: (Pair | LineFold)[] = [];
  for (let at = 0; at < pairs.length; ) {
    let end = at;
    while (end < pairs.length && folds(end)) end++;
    if (end - at > 1) {
      entries.push({ kind: "fold", at, pairs: pairs.slice(at, end) });
      at = end;
    } else {
      entries.push(pairs[at]!);
      at++;
    }
  }
  return entries;
}
