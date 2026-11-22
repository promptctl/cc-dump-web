import type { Block } from "../format/blocks.ts";
import { beyondContext, diffOf, lineDiff, marks, wordDiff, type Edit } from "../format/diff.ts";
import { fieldLines, jsonText, type Part } from "../format/parts.ts";

// What a step rewrote in a block (docs/design/02-design.md, "Two axes"): the block before against the block after as
// a unified diff, the lines a change removed above the lines it added, a line replaced by another marked word by word,
// and runs of unchanged lines folded.

// A line of the diff: what the change did to it, and its words, each marked for what the change did to it: a line
// replaced by another word by word, any other the line whole.
export type DiffLine = { kind: "line"; change: Edit["change"]; words: Edit[] };

// A run of unchanged lines folded into one, `at` its first line's place among the diff's lines, which names it.
export type LineFold = { kind: "fold"; at: number; lines: DiffLine[] };

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
        .map(({ name, value, path }) => `${"  ".repeat(path.length - 1)}${name}:${value === undefined ? "" : ` ${value}`}`)
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

// [LAW:one-source-of-truth] What a block shows beside its content, which a version is decided by with it
// (view/history.ts, content): its category, with whether the harness injected it, and its name, a line each, so a step
// that rewrote one of them alone is a diff that says which.
const headText = ({ category, name, injected }: Block): string => `${category}${injected === undefined ? "" : ", injected"}\n${name}`;

// [LAW:one-source-of-truth] Each pair of blocks is diffed once, when it is first shown, so a frame that shows it again
// does not pay for it again; and only then, so a block's past never opened is never diffed.
const diffs = new WeakMap<Block, WeakMap<Block, (DiffLine | LineFold)[]>>();
export function blockDiff(before: Block, after: Block): (DiffLine | LineFold)[] {
  const made = diffs.get(before)?.get(after);
  if (made !== undefined) return made;
  const afters = diffs.get(before) ?? new WeakMap<Block, (DiffLine | LineFold)[]>();
  diffs.set(before, afters);
  // Of the blocks' heads, the lines the change rewrote, none where it rewrote the content alone; then the content's.
  const head = linesOf(lineDiff(headText(before), headText(after))).filter(({ change }) => change !== "same");
  const diff = folded([...head, ...linesOf(lineDiff(blockText(before), blockText(after)))]);
  afters.set(after, diff);
  return diff;
}

// The diff's lines with their words: a kept line as it is; and of each run of changes, the lines removed, then the
// lines added, the first removed replaced by the first added and so on in order, the lines one side has more of whole.
function linesOf(edits: Edit[]): DiffLine[] {
  const lines: DiffLine[] = [];
  for (let at = 0; at < edits.length; ) {
    let end = at;
    while (end < edits.length && edits[end]!.change !== "same") end++;
    if (end === at) {
      lines.push({ kind: "line", change: "same", words: [edits[at]!] });
      at++;
      continue;
    }
    const of = (change: Edit["change"]) => edits.slice(at, end).filter((edit) => edit.change === change);
    const [removed, added] = [of("removed"), of("added")];
    const replaced = removed.slice(0, added.length).map(({ text }, index) => wordDiff(text, added[index]!.text));
    // A replaced line's words on each side: those the change kept, and those it removed from, or added to, that side.
    const side = (lines: Edit[], other: Edit["change"]) =>
      lines.map((edit, index): DiffLine => ({ kind: "line", change: edit.change, words: replaced[index]?.filter(({ change }) => change !== other) ?? [edit] }));
    lines.push(...side(removed, "added"), ...side(added, "removed"));
    at = end;
  }
  return lines;
}

// The lines with each run of unchanged ones folded, beyond `context` lines beside a change; a run of one is listed,
// since its fold would take the line it saves.
function folded(lines: DiffLine[]): (DiffLine | LineFold)[] {
  const far = beyondContext(lines.map(({ change }) => change !== "same"));
  const entries: (DiffLine | LineFold)[] = [];
  for (let at = 0; at < lines.length; ) {
    let end = at;
    while (end < lines.length && far[end]) end++;
    if (end - at > 1) {
      entries.push({ kind: "fold", at, lines: lines.slice(at, end) });
      at = end;
    } else {
      entries.push(lines[at]!);
      at++;
    }
  }
  return entries;
}
