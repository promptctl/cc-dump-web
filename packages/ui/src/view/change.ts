import type { Block } from "../format/blocks.ts";
import { beyondContext, diffOf, joined, lineDiff, marks, wordDiff, type Edit, type Joined } from "../format/diff.ts";
import { fieldLines, jsonText, type Part } from "../format/parts.ts";
import type { Folded } from "./rendering.ts";

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

// A run of unchanged pairs folded into one line, named, as a text's region is, by the line it opens on in the version
// shown, the right.
export type LineFold = { kind: "fold"; line: number; pairs: Pair[] };

// A block's diff: its pairs in order with the unchanged runs folded; and each side's text, each line a passage, the
// right's, the later version's, as the search reads it, with the characters of each fold.
export type BlockDiff = { entries: (Pair | LineFold)[]; left: Joined; right: Folded };

// [LAW:one-source-of-truth] A block as one text, so every kind of block is compared one way: its parts in order, a blank
// line between them; a text as written, JSON as formatted, a field a line of its own, `name: value`, indented under the
// field holding it, a diff its lines as a unified diff writes them, and media what it is, its base64 by a digest, so two
// images differ in the diff when they do. Labels are the view's words, not the block's.
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
          return `[${of}: ${source.media_type}, ${source.data.length} characters of base64, FNV-1a ${fnv1a(source.data)}]`;
        case "url":
          return `[${of}: ${source.url}]`;
        case "file":
          return `[${of}: file ${source.file_id}]`;
      }
    }
  }
}

// The 32-bit FNV-1a hash of a text's UTF-16 code units, in hex: a digest of a medium's content short enough for its line.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

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
  const side = (lines: (SideLine | undefined)[]) => joined(lines.flatMap((line) => (line === undefined ? [] : [line.words.map(({ text }) => text).join("")])));
  const right = side(pairs.map(({ right }) => right));
  const folds = entries.flatMap((entry) =>
    entry.kind === "fold" ? [{ start: right.passages[entry.line]!.start, end: right.passages[entry.line + entry.pairs.length - 1]!.end, line: entry.line }] : [],
  );
  return { entries, left: side(pairs.map(({ left }) => left)), right: { ...right, folds } };
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
  const far = beyondContext(pairs.map(({ kind }) => kind !== "same"));
  const entries: (Pair | LineFold)[] = [];
  for (let at = 0; at < pairs.length; ) {
    let end = at;
    while (end < pairs.length && far[end]) end++;
    if (end - at > 1) {
      entries.push({ kind: "fold", line: pairs[at]!.right!.line, pairs: pairs.slice(at, end) });
      at = end;
    } else {
      entries.push(pairs[at]!);
      at++;
    }
  }
  return entries;
}
