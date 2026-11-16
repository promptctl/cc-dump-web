import type { Block, Category, Part } from "../format/blocks.ts";
import type { FormattedExchange, Group, KeyedBlock } from "../format/format.ts";
import type { Branches, Unchanged, Visibility } from "../settings.ts";
import type { Branch, History, Item, Segment } from "./history.ts";

// The conversation at a moment as the rows the view lists, one line or one block each, so only the rows on screen are
// mounted. Each row is two sides (docs/design/02-design.md, "Two axes"): the right the conversation at the step shown,
// the left at the step before, aligned as a side-by-side diff.

// What the step shown did to a row: brought it (`added`, against an empty slot on the left), left it as it was
// (`same`), gave its item a new version (`changed`), or took it away (`removed`, against an empty slot on the right).
export type Change = "added" | "same" | "changed" | "removed";

// [LAW:types-are-the-program] A row's key names what it shows: an exchange's line its trace_id, a group's title
// `<trace_id>/<group key>`, a block its item's key (view/history.ts), so it is the same row at every moment and however
// many rows arrive around it. A block row shows the item's version at the step shown, `block`, and the one before,
// `before`, which is none for a block the step added, and a block the step removed shows only the one before. A fold
// stands for a run of unchanged rows, or of a branch's, keyed by the first: that row is listed exactly when the fold is
// not, so a place held at it holds whether the fold is closed, opened, or gone. `branch`: the branch a row is part of.
export type Row =
  | { kind: "exchange"; key: string; exchange: FormattedExchange; change: Change; branch: Branch | undefined }
  | { kind: "group"; key: string; title: Group["title"]; change: Change; branch: Branch | undefined }
  | { kind: "block"; key: string; block: KeyedBlock; before: KeyedBlock | undefined; change: Exclude<Change, "removed">; branch: Branch | undefined }
  | { kind: "block"; key: string; block: undefined; before: KeyedBlock; change: "removed"; branch: Branch | undefined }
  | { kind: "fold"; key: string; count: number; branch: Branch | undefined };

// The rows of the conversation at a moment, and their keys: those listed, which are every row but the blocks of a hidden
// category, the group titles over none left, and the runs of unchanged rows folded, the block revealed always among them;
// and `every` row, listed or not, which the search reads, since a hidden category's blocks are searched
// (docs/design/01-mvp.md, F6).
export type Layout = { rows: Row[]; keys: Keys; every: { rows: Row[]; keys: Keys } };

// The rows' keys in order: the key at an index, and the index of a key: of its row, or, for a row not listed, of the
// fold it is in, or else the row listed before it, whose end is where it stands. [LAW:types-are-the-program] The same
// object while no row, listed or not, arrives, goes or moves, so what places rows by key (the virtualizer, from the first
// row) places them again only when one did.
export type Keys = { at: (index: number) => string; indexOf: (key: string) => number | undefined };

// How many unchanged rows stay listed beside a change, above and below it, as a diff's context lines do.
export const context = 3;

// The key a fold is opened by, among the flips, by its first row's key: a flip of its own, apart from that row's.
export const foldKey = (first: string) => `fold:${first}`;

// Lays out the conversation at step `step` of `history`, leaving out the blocks of each category `visibility` hides
// (docs/design/01-mvp.md, F5) but the one at the key `revealed`, which the search has stepped to (F6), and a group with
// no block left, rather than a title over nothing; and, while `unchanged` folds, each run of unchanged rows not opened in
// `opened`, beyond the context beside a change. The revealed block is never folded, so a step of the search lists it
// in the layout that reveals it. A step of 0 is the conversation before anything arrived.
// A branch's segment is listed by `branches` once the branch's last request is behind the step shown (settings.ts).
export function createLayout(
  visibility: Record<Category, Visibility>,
  unchanged: Unchanged,
  branches: Branches,
): (history: History, step: number, revealed: string | undefined, opened: Record<string, true>) => Layout {
  let last: Layout = { rows: [], keys: keysOf([], new Map()), every: { rows: [], keys: keysOf([], new Map()) } };
  const place = placements[branches];
  return (history, step, revealed, opened) => {
    // Each row of a branch folded into one, by the branch.
    const collapsed = new Map<string, Branch>();
    const every = history.segments.slice(0, step).flatMap((segment, index) => {
      const past = segment.branch === undefined ? 0 : Math.max(0, step - history.branches.get(segment.branch.key)!);
      const { rows, collapses } = place(() => segmentRows(segment, index + 1, step), () => segmentRows(segment, index + 1, step - 1).map(removed), past);
      if (collapses) for (const row of rows) collapsed.set(row.key, segment.branch!);
      return rows;
    });
    const isShown = every.map((row) => row.kind !== "block" || isListed[visibility[(row.change === "removed" ? row.before : row.block).category]] || row.key === revealed);
    // A group's title is listed over a block of it listed: read from the end, whether one follows before the next title.
    let blockListed = false;
    for (let index = every.length - 1; index >= 0; index--) {
      const { kind } = every[index]!;
      if (kind === "group") isShown[index] = blockListed;
      blockListed = kind === "block" ? blockListed || isShown[index]! : false;
    }
    const listed = every.filter((_, index) => isShown[index]);
    const folding = fold(listed, revealed, opened, unchanged, collapsed);
    // Each row's place among those listed: its own, the fold it is in, or the place of the row listed before it.
    const places = folding.placeOf;
    let before = 0;
    every.forEach((row, index) => {
      if (isShown[index]) before = places.get(row.key)!;
      else places.set(row.key, before);
    });
    const listedKeys = folding.rows.map(({ key }) => key);
    const everyKeys = every.map(({ key }) => key);
    const sameKeys = same(everyKeys, last.every.rows.map(({ key }) => key));
    const sameEvery = sameKeys && every.every((row, index) => blockOf(row) === blockOf(last.every.rows[index]!));
    last = {
      rows: folding.rows,
      // What a row shows changing, as a streaming block does, moves no row, so the keys are the ones before.
      keys: sameKeys && same(listedKeys, last.rows.map(({ key }) => key)) ? last.keys : keysOf(listedKeys, places),
      // [LAW:one-source-of-truth] The search reads every row's block alone, so the same blocks are the same `every`, and
      // what memoizes on it is not run again by a step of the search or of time that changed none.
      every: sameEvery ? last.every : { rows: every, keys: keysOf(everyKeys, new Map(everyKeys.map((key, index) => [key, index]))) },
    };
    return last;
  };
}

// [LAW:dataflow-not-control-flow] What each placement lists of a branch's segment `past` steps after the branch's last
// request, 0 while it is not behind the step shown, from its rows at the step shown and its rows removed; and whether
// they fold into one.
type Placement = (rows: () => Row[], removed: () => Row[], past: number) => { rows: Row[]; collapses: boolean };
const placements: Record<Branches, Placement> = {
  stay: (rows) => ({ rows: rows(), collapses: false }),
  fold: (rows, _removed, past) => ({ rows: rows(), collapses: past > 0 }),
  step: (rows, removed, past) => ({ rows: past === 0 ? rows() : past === 1 ? removed() : [], collapses: false }),
};

// A row a segment lists while it is shown: no fold, and a block with a version at the step shown.
type Shown = Extract<Row, { kind: "exchange" | "group" }> | Extract<Row, { kind: "block"; block: KeyedBlock }>;

// The rows of step `own`'s segment at step `step`: its exchange's line, then each group's title and items.
function segmentRows({ formatted, groups, branch }: Segment, own: number, step: number): Shown[] {
  const change = own === step ? "added" : "same";
  const trace = formatted.exchange.trace_id;
  return [
    { kind: "exchange", key: trace, exchange: formatted, change, branch },
    ...groups
      .filter(({ items }) => items.length > 0)
      .flatMap(({ key, title, items }): Shown[] => [{ kind: "group", key: `${trace}/${key}`, title, change, branch }, ...items.map((item) => itemRow(item, own, step, branch))]),
  ];
}

// An item's row at step `step`: its version then, and the one before, unless step `own`, the step it arrived at, is it.
function itemRow(item: Item, own: number, step: number, branch: Branch | undefined): Shown {
  const now = versionAt(item, step);
  const before = own === step ? undefined : versionAt(item, step - 1);
  return { kind: "block", key: item.key, block: now.block, before: before?.block, change: before === undefined ? "added" : before === now ? "same" : "changed", branch };
}

// A row the step shown took away: what it showed at the step before, on the left alone.
function removed(row: Shown): Row {
  return row.kind === "block" ? { kind: "block", key: row.key, block: undefined, before: row.block, change: "removed", branch: row.branch } : { ...row, change: "removed" };
}

// An item's version at a step at or after the one it arrived at.
function versionAt(item: Item, step: number) {
  return item.versions.findLast((version) => version.step <= step)!;
}

const blockOf = (row: Row) => (row.kind === "block" ? row.block : undefined);

// The listed rows with each run of a branch's rows `collapsed` folded, unless opened in `opened` or the block revealed is
// in it; then each run of unchanged rows folded, beyond `context` rows beside a change, unless opened or the reader shows
// every unchanged row, `revealed` never among them, and no branch's row. A branch's fold is one row, so it is as far from
// a change as the row it is listed as. `placeOf`: each listed row's place among the rows.
function fold(
  listed: Row[],
  revealed: string | undefined,
  opened: Record<string, true>,
  unchanged: Unchanged,
  collapsed: ReadonlyMap<string, Branch>,
): { rows: Row[]; placeOf: Map<string, number> } {
  const isOpened = (run: Row[]) => opened[foldKey(run[0]!.key)] === true;
  const branchOf = (row: Row) => collapsed.get(row.key);
  const branches = foldRuns(
    listed,
    (at, first) => branchOf(listed[first]!) !== undefined && branchOf(listed[at]!)?.key === branchOf(listed[first]!)!.key,
    (run) => isOpened(run) || run.some(({ key }) => key === revealed),
    (row) => branchOf(row),
  );
  const rows = branches.rows;
  const changed = (row: Row) => row.kind !== "fold" && row.change !== "same";
  // How far each row is from the nearest change above it and below it.
  const above: number[] = [];
  rows.forEach((row, index) => (above[index] = changed(row) ? 0 : (above[index - 1] ?? Infinity) + 1));
  const below: number[] = [];
  for (let index = rows.length - 1; index >= 0; index--) below[index] = changed(rows[index]!) ? 0 : (below[index + 1] ?? Infinity) + 1;
  const folds = (index: number) => unchanged === "fold" && above[index]! > context && below[index]! > context && rows[index]!.key !== revealed && branchOf(rows[index]!) === undefined;
  const unchangedRuns = foldRuns(rows, folds, isOpened, () => undefined);
  const placeOf = new Map(listed.map(({ key }) => [key, unchangedRuns.placeOf.get(rows[branches.placeOf.get(key)!]!.key)!]));
  return { rows: unchangedRuns.rows, placeOf };
}

// The rows with each run of them `inRun` takes from its first row, at `first`, folded into one row of `branch`, unless
// `open` keeps it listed. A row in no run is a run of its own, and a run of one row is listed as itself, which is what its
// fold would take the room of. `placeOf`: each row's place among those listed, a folded row's its fold's.
function foldRuns(
  rows: Row[],
  inRun: (at: number, first: number) => boolean,
  open: (run: Row[]) => boolean,
  branch: (first: Row) => Branch | undefined,
): { rows: Row[]; placeOf: Map<string, number> } {
  const listed: Row[] = [];
  const placeOf = new Map<string, number>();
  for (let index = 0; index < rows.length; ) {
    let end = index;
    while (end < rows.length && inRun(end, index)) end++;
    const run = rows.slice(index, Math.max(end, index + 1));
    const folded = run.length > 1 && !open(run);
    for (const row of run) {
      placeOf.set(row.key, listed.length);
      if (!folded) listed.push(row);
    }
    if (folded) listed.push({ kind: "fold", key: run[0]!.key, count: run.length, branch: branch(run[0]!) });
    index += run.length;
  }
  return { rows: listed, placeOf };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((key, at) => key === b[at]);

// The keys of the rows listed, in order, and each key's place among them.
function keysOf(keys: string[], places: Map<string, number>): Keys {
  return { at: (index) => keys[index]!, indexOf: (key) => places.get(key) };
}

// [LAW:types-are-the-program] Whether a block of each visibility is listed: the compiler asks for an entry for each.
const isListed: Record<Visibility, boolean> = { shown: true, hidden: false };

// The text a JSON part shows. [LAW:one-source-of-truth] Serialized once per part, which the formatter keeps the same
// object while its side of the exchange is unchanged, for the block's size, its view and the search; the cache is this
// function's own.
const jsonTexts = new WeakMap<Extract<Part, { kind: "json" }>, string>();
export function jsonText(part: Extract<Part, { kind: "json" }>): string {
  const text = jsonTexts.get(part) ?? JSON.stringify(part.value, null, 2) ?? "undefined";
  jsonTexts.set(part, text);
  return text;
}

// How much a block holds, in characters of its content: what its collapsed line says, and what its expanded height is
// estimated from. A JSON string is counted by its length, so a tool's input still streaming is not serialized each time.
// Counted once per block, which the formatter keeps the same object while its side of the exchange is unchanged.
const sizes = new WeakMap<Block, number>();
export function sizeOf(block: Block): number {
  const size = sizes.get(block) ?? block.parts.reduce((size, part) => size + partSize(part), 0);
  sizes.set(block, size);
  return size;
}
function partSize(part: Part): number {
  switch (part.kind) {
    case "text":
      return part.text.length;
    case "json":
      return typeof part.value === "string" ? part.value.length : jsonText(part).length;
    case "fields":
      return part.fields.reduce((length, [name, value]) => length + name.length + value.length, 0);
    case "media":
      return part.source.type === "base64" ? part.source.data.length : part.source.type === "url" ? part.source.url.length : part.source.file_id.length;
  }
}

// A count to one decimal of the largest unit it reaches once rounded, so 999,960 reads 1.0M, not 1000.0k.
export function compact(count: number): string {
  if (count < 1000) return `${count}`;
  const thousands = (count / 1000).toFixed(1);
  return Number(thousands) < 1000 ? `${thousands}k` : `${(count / 1_000_000).toFixed(1)}M`;
}

// A size in characters.
export const describeSize = (size: number): string => `${compact(size)} chars`;

// What a block's line shows after its name (docs/design/02-design.md, "Print what varies"): the start of its first text
// or JSON part on one line, as much as a line could hold, and an ellipsis where it was cut. A block with neither, a tool
// result with only its id, shows nothing.
export function preview(block: Block): string {
  const part = block.parts.find((part) => part.kind === "text" || part.kind === "json");
  // A JSON string, as a tool's input is while it streams, is its own text, so it is never serialized for a line; any
  // other value's serialization is jsonText's, which the block's size has already made.
  const text = part === undefined ? "" : part.kind === "text" ? part.text : typeof part.value === "string" ? part.value : jsonText(part);
  // A long text is read only a few lines' worth ahead, enough to fill the line once its whitespace, JSON's indentation
  // included, is collapsed; each cut is at a whole character, not between a surrogate pair's halves, and the ellipsis
  // says something visible was cut.
  const scanned = wholeCut(text, previewLength * 4);
  const collapsed = scanned.replace(/\s+/g, " ").trim();
  const line = wholeCut(collapsed, previewLength);
  return line.length < collapsed.length || /\S/.test(text.slice(scanned.length)) ? `${line.trimEnd()}…` : line;
}
const previewLength = 200;

// The first `length` code units of `text`, one fewer where the last would be the first half of a surrogate pair.
function wholeCut(text: string, length: number): string {
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

// A recorded timestamp as the clock read, to the second.
export function clockTime(timestamp: string): string {
  return clock.format(Date.parse(timestamp));
}
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

// A duration in milliseconds as seconds to one decimal.
export function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

// Whether a block at `key` shows expanded: as its category starts, the user's and the assistant's expanded and the rest
// collapsed, and what the harness injected into their messages collapsed with the rest, since it is not what they said
// (docs/design/01-mvp.md, F4), unless the reader flipped it. One flip turns both sides of a row, and each side starts as
// its own version does.
export function isExpanded(flipped: Record<string, true>, key: string, block: Block): boolean {
  return (flipped[key] === true) !== startsExpanded(block);
}
const startsExpanded = ({ category, injected }: Block): boolean => injected === undefined && (category === "user" || category === "assistant");

// A row's height before it is measured, in pixels: one line, an exchange's band with the space above it, or a block's
// content at about 100 characters a line, on its taller side. Only rows not yet on screen use it, so it decides how the
// scrollbar reads, not where anything lands.
export function estimateHeight(row: Row, flipped: Record<string, true>): number {
  const line = 20;
  const side = (block: Block | undefined) => (block !== undefined && isExpanded(flipped, row.key, block) ? line + Math.ceil(sizeOf(block) / 100) * 16 : line);
  switch (row.kind) {
    case "exchange":
      return 36;
    case "group":
    case "fold":
      return line;
    case "block":
      return Math.max(side(row.block), side(row.before));
  }
}
