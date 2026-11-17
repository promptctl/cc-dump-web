import type { Block, Category } from "../format/blocks.ts";
import { diffOf } from "../format/diff.ts";
import { fieldLines, fieldValue, jsonText, type Field, type Part } from "../format/parts.ts";
import type { FormattedExchange, Heading, KeyedBlock } from "../format/format.ts";
import type { Branches, Visibility } from "../settings.ts";
import type { Branch, History, Item, Segment, Version } from "./history.ts";
import { renderingOf } from "./rendering.ts";

// The conversation at a moment as the rows the view lists, one line or one block each, in one column
// (docs/design/02-design.md, "Two axes"), so only the rows on screen are mounted.

// What a step did to a row: brought it (`added`), left it as it was (`same`), gave its item a new version
// (`changed`), or took it away (`removed`).
export type Change = "added" | "same" | "changed" | "removed";
// [LAW:one-source-of-truth] The theme's variable for what a step did to a row, which colors the band at its edge and
// its mark on the minimap; none for a row left as it was.
export const changeColors: Record<Change, `--${string}` | undefined> = { added: "--success", changed: "--warning", removed: "--error", same: undefined };

// [LAW:types-are-the-program] A row's key names what it shows: an exchange's line its trace_id, a group's title or a
// set's line `<trace_id>/<group key>`, a block its item's key (view/history.ts), so it is the same row at every moment
// and however many rows arrive around it. `change`: what the step shown did to the row, which brings an exchange's line
// and a group's title or leaves them, and rewrites or takes away a block alone. A block's row shows one version of its
// item, the one at the step shown, `versions[at]`: its block, or, once a step took the item away, the block it was,
// which stays listed at its place (blockOf). `versions` is the item's own, the same array while the item gets no
// version, so a row made again as it was has the fields it had. `set`: the key of the set's line a block is listed
// under, for one of a set. A fold stands for a run of a branch's rows, the `rows` it holds, keyed by the first: that row
// is listed exactly when the fold is not, so a place held at it holds whether the fold is closed, opened, or gone.
// `branch`: the branch a row is part of.
export type Row =
  | { kind: "exchange"; key: string; exchange: FormattedExchange; change: "added" | "same"; branch: Branch | undefined }
  | { kind: "group"; key: string; title: Heading; change: "added" | "same"; branch: Branch | undefined }
  | SetRow
  | BlockRow
  | { kind: "fold"; key: string; rows: Row[]; branch: Branch };
export type BlockRow = { kind: "block"; key: string; change: Change; versions: readonly Version[]; at: number; branch: Branch | undefined; set: string | undefined };
// [LAW:types-are-the-program] A set's line: the title of a group whose blocks are a set, blocks of one kind and one
// category that read as one thing, as a request's tool definitions do. It stands for them while it is closed, when
// none of them is listed, and over them while it is open (docs/design/01-mvp.md, F4). It holds the group's `items`,
// the history's own array, and the step shown, which its blocks' rows are read from (blocksOf), so it is the same
// fields while none of its items gets a version. `change`: what the step shown did to the set, which brings it, leaves
// it, or changes it, by doing anything to a block of it.
export type SetRow = { kind: "set"; key: string; title: Heading; change: "added" | "same" | "changed"; branch: Branch | undefined; items: readonly Item[]; step: number };

// [LAW:dataflow-not-control-flow] The headings whose blocks are a set. Another set is another entry.
const sets: ReadonlySet<Heading> = new Set<Heading>(["tools"]);

// The block a version shows: its own, or, of one a step took away, the block it was.
const blockIn = (version: Version): KeyedBlock => (version.block === undefined ? version.was : version.block);

// [LAW:one-source-of-truth] The block a row shows: its version's, read from it and kept nowhere else.
export const blockOf = ({ versions, at }: BlockRow): KeyedBlock => blockIn(versions[at]!);

// [LAW:types-are-the-program] What a step did to an item: brought it, took it away, or rewrote it, the block before
// into the block after.
export type Event = { step: number } & ({ change: "added" | "removed" } | { change: "changed"; before: KeyedBlock; after: KeyedBlock });

// [LAW:one-source-of-truth] What a version did to its item, as the history says it of the version (view/history.ts):
// took it away; brought it, the first, or one sent again as it was after a step took it away; or gave it other content
// than it last had, sent again or not.
function eventOf(version: Version): Event {
  const { step, block } = version;
  if (block === undefined) return { step, change: "removed" };
  return version.rewrote === undefined ? { step, change: "added" } : { step, change: "changed", before: version.rewrote, after: block };
}

// A block's past at the step shown: what each step did to its item since it arrived, in order. None for a block as it
// arrived, which is nearly every one.
export function pastOf({ versions, at }: BlockRow): Event[] {
  const events = versions.slice(0, at + 1).map(eventOf);
  return events[0]!.change === "added" ? events.slice(1) : events;
}

// The last of a block's past, read without listing it: what the version shown did, but for a block as it arrived.
export const lastOf = ({ versions, at }: BlockRow): Event | undefined => (at === 0 && versions[0]!.block !== undefined ? undefined : eventOf(versions[at]!));

// Whether a step took a block's item away by the step shown: its row shows the block it was.
export const isGone = ({ versions, at }: BlockRow): boolean => versions[at]!.block === undefined;

// [LAW:one-source-of-truth] Whether a block's line opens: one with no content, a branch's line for what it does not
// send (view/history.ts), has nothing to open, so it is no control and no stop of a move among the blocks.
export const lineOpens = (block: Block): boolean => block.parts.length > 0;

// A row's mark on the minimap: what the step shown did to it, or, where it left it as it was, the last thing a step did
// to it since it arrived, so a block rewritten or taken away is marked at every step after.
export function markOf(row: Row): Change {
  if (row.kind === "fold") return "same";
  if (row.change !== "same") return row.change;
  return row.kind === "block" ? (lastOf(row)?.change ?? "same") : row.kind === "set" ? (summaryOf(row).last?.event.change ?? "same") : "same";
}

// The rows of a set's blocks at the step it shows, in order: listed under its line while it is open.
export const blocksOf = ({ key, items, step, branch }: SetRow): BlockRow[] => items.map((item) => itemRow(item, step, branch, key));

// The category of a set's blocks, which is one.
export const categoryOf = ({ items }: SetRow): Category => blockIn(items[0]!.versions[0]!).category;

// What a set's line says of its blocks (docs/design/02-design.md, "Print what varies"): how many the conversation holds
// at the step shown, their names, and their size together; and what steps did to them since they arrived, which the
// closed line must not lose: the last thing a step did to one of them, with its name, and how many of them a step did
// anything to.
export type Summary = { count: number; names: string[]; size: number; last: { name: string; event: Event } | undefined; touched: number };
export function summaryOf(set: SetRow): Summary {
  const rows = blocksOf(set);
  const held = rows.filter((row) => !isGone(row)).map(blockOf);
  const touched = rows.flatMap((row) => {
    const event = lastOf(row);
    return event === undefined ? [] : [{ name: blockOf(row).name, event }];
  });
  return {
    count: held.length,
    names: held.map(({ name }) => name),
    size: held.reduce((size, block) => size + sizeOf(block), 0),
    last: touched.reduce<Summary["last"]>((last, one) => (last === undefined || one.event.step >= last.event.step ? one : last), undefined),
    touched: touched.length,
  };
}

// The rows of the conversation at a moment, and their keys: those listed, which are every row but the blocks of a hidden
// category and of a closed set, and the titles over none a level lists, the block revealed always among them; and
// `every` row, listed or not, which the search reads, since a hidden category's blocks and a closed set's are searched
// (docs/design/01-mvp.md, F6).
export type Layout = { rows: Row[]; keys: ListedKeys; every: { rows: Row[]; keys: Keys } };

// The rows' keys in order: the key at an index, and the index of a key: of its row, or, for a row not listed, of the
// fold it is in, or else the row listed before it, whose end is where it stands. [LAW:types-are-the-program] The same
// object while no row, listed or not, arrives, goes or moves, so what reads rows by key reads them again only when one
// did.
export type Keys = { at: (index: number) => string; indexOf: (key: string) => number | undefined };
// The keys of the rows listed, which the virtualizer places, and the key it keeps each one's measured height by
// (measuredBy): the same object, too, while no row's height is measured by another key.
export type ListedKeys = Keys & { measuredBy: (index: number) => string };

// [LAW:one-source-of-truth] What the reader chose to show of each block, region or fold they opened or closed, by key:
// open, or closed. A key with no choice shows as it starts. A choice is kept as made, the same as how the key starts now
// or not, since how a block starts moves with its category's level and the choice outlasts a change of level
// (docs/design/01-mvp.md, F4).
export type Opened = Record<string, boolean>;
export const isOpen = (opened: Opened, key: string, starts: boolean): boolean => opened[key] ?? starts;

// The key a fold is opened by, among the choices, by its first row's key: a choice of its own, apart from that row's.
export const foldKey = (first: string) => `fold:${first}`;
// The key a block's past is opened by, by its row's key: a choice of its own, too, which starts closed whatever the
// block's level, since a block rewritten at most steps holds as many diffs.
export const pastKey = (key: string) => `past:${key}`;

// Lays out the conversation at step `step` of `history`, leaving out the blocks of each category `visibility` hides
// (docs/design/01-mvp.md, F5) and of each set that shows closed (F4) but the one at the key `revealed`, which the
// search has stepped to (F6), and a group or a set with no block a level lists, rather than a title over nothing. The
// revealed block is never folded, so a step of the search lists it in the layout that reveals it. A step of 0 is the
// conversation before anything arrived.
// A branch's segment is listed by `branches` once the branch's last request is behind the step shown (settings.ts).
export function createLayout(
  visibility: Record<Category, Visibility>,
  branches: Branches,
): (history: History, step: number, revealed: string | undefined, opened: Opened) => Layout {
  let last: Layout = { rows: [], keys: listedKeysOf([], [], new Map()), every: { rows: [], keys: keysOf([], new Map()) } };
  const place = placements[branches];
  return (history, step, revealed, opened) => {
    // The keys of the branches folded into one row each.
    const collapsed = new Set<string>();
    const placed = history.segments.slice(0, step).map((segment, index) => {
      const past = segment.branch === undefined ? 0 : Math.max(0, step - history.branches.get(segment.branch.key)!);
      const { listed, collapses } = place(past);
      if (collapses) collapsed.add(segment.branch!.key);
      return listed ? segmentRows(segment, index + 1, step) : [];
    });
    const every = placed.flat();
    // A title, a group's or a set's, is listed over a block of it a level lists: read from the end, whether one follows
    // before the next title. A set's block is listed under its line only while the set is open.
    const isShown = every.map(() => true);
    let titled = false;
    for (let index = every.length - 1; index >= 0; index--) {
      const row = every[index]!;
      if (row.kind === "block") {
        const levelLists = levels[visibility[blockOf(row).category]].listed;
        isShown[index] = row.key === revealed || (levelLists && closedSetOf(row, visibility, opened) === undefined);
        titled ||= levelLists || row.key === revealed;
        continue;
      }
      if (row.kind !== "exchange") isShown[index] = titled;
      titled = false;
    }
    const listed = every.filter((_, index) => isShown[index]);
    const folding = fold(listed, revealed, opened, collapsed);
    // Each row's place among those listed: its own, the fold it is in, or the place of the row listed before it.
    const places = folding.placeOf;
    let before = 0;
    every.forEach((row, index) => {
      if (isShown[index]) before = places.get(row.key)!;
      else places.set(row.key, before);
    });
    const listedKeys = folding.rows.map(({ key }) => key);
    const listedMeasured = folding.rows.map((row) => measuredBy(row, visibility, opened));
    const everyKeys = every.map(({ key }) => key);
    const sameKeys = same(everyKeys, last.every.rows.map(({ key }) => key));
    const sameEvery = sameKeys && every.every((row, index) => versionOf(row) === versionOf(last.every.rows[index]!));
    last = {
      rows: folding.rows,
      // What a row shows changing, as a streaming block does, moves no row, so the keys are the ones before.
      keys:
        sameKeys && same(listedKeys, last.rows.map(({ key }) => key)) && listedMeasured.every((key, index) => key === last.keys.measuredBy(index))
          ? last.keys
          : listedKeysOf(listedKeys, listedMeasured, places),
      // [LAW:one-source-of-truth] The search reads of every row the version it shows alone, its block and whether a
      // step took it away, so the same versions are the same `every`, and what memoizes on it is not run again by a
      // step of the search or of time that changed none.
      every: sameEvery ? last.every : { rows: every, keys: keysOf(everyKeys, new Map(everyKeys.map((key, index) => [key, index]))) },
    };
    return last;
  };
}

// [LAW:dataflow-not-control-flow] What each placement does with a branch's segment `past` steps after the branch's last
// request, 0 while it is not behind the step shown: whether its rows are listed, and whether they fold into one.
const placements: Record<Branches, (past: number) => { listed: boolean; collapses: boolean }> = {
  stay: () => ({ listed: true, collapses: false }),
  fold: (past) => ({ listed: true, collapses: past > 0 }),
  step: (past) => ({ listed: past === 0, collapses: false }),
};

// A row a segment lists while it is shown: any but a fold.
type Shown = Exclude<Row, { kind: "fold" }>;

// The rows of step `own`'s segment at step `step`: its exchange's line, then each group's items' rows, under its title
// where it has one and an item: a set's line, for a group whose blocks are a set.
function segmentRows({ formatted, groups, branch }: Segment, own: number, step: number): Shown[] {
  const change = own === step ? "added" : "same";
  const trace = formatted.exchange.trace_id;
  return [
    { kind: "exchange", key: trace, exchange: formatted, change, branch },
    ...groups.flatMap(({ key: group, title, items }): Shown[] => {
      const key = `${trace}/${group}`;
      if (title === undefined || items.length === 0) return items.map((item) => itemRow(item, step, branch, undefined));
      if (!sets.has(title)) return [{ kind: "group", key, title, change, branch }, ...items.map((item) => itemRow(item, step, branch, undefined))];
      const set: SetRow = { kind: "set", key, title, change, branch, items, step };
      const blocks = blocksOf(set);
      return [{ ...set, change: change === "same" && blocks.some((block) => block.change !== "same") ? "changed" : change }, ...blocks];
    }),
  ];
}

// An item's row at step `step`, a step at or after the one it arrived at: its version then, and what the step did to
// it if that version is the step's. `set`: the key of the set's line it is listed under, if any.
function itemRow({ key, versions }: Item, step: number, branch: Branch | undefined, set: string | undefined): BlockRow {
  const at = versions.findLastIndex((version) => version.step <= step);
  return { kind: "block", key, change: versions[at]!.step === step ? eventOf(versions[at]!).change : "same", versions, at, branch, set };
}

// The version a row shows, which only a block's row does.
const versionOf = (row: Row) => (row.kind === "block" ? row.versions[row.at] : undefined);

// The listed rows with each run of rows of a branch in `collapsed` folded, unless opened in `opened` or the block
// revealed is in it. `placeOf`: each listed row's place among the rows.
function fold(
  listed: Row[],
  revealed: string | undefined,
  opened: Opened,
  collapsed: ReadonlySet<string>,
): { rows: Row[]; placeOf: Map<string, number> } {
  const isOpened = (run: Row[]) => isOpen(opened, foldKey(run[0]!.key), false);
  const branchOf = ({ branch }: Row) => (branch !== undefined && collapsed.has(branch.key) ? branch : undefined);
  return foldRuns(
    listed,
    (at, first) => branchOf(listed[first]!) !== undefined && branchOf(listed[at]!)?.key === branchOf(listed[first]!)!.key,
    (run) => isOpened(run) || run.some(({ key }) => key === revealed),
    (row) => branchOf(row)!,
  );
}

// The rows with each run of them `inRun` takes from its first row, at `first`, folded into one row of `branch`, unless
// `open` keeps it listed. A row in no run is a run of its own, and a run of one row is listed as itself, which is what its
// fold would take the room of. `placeOf`: each row's place among those listed, a folded row's its fold's.
function foldRuns(
  rows: Row[],
  inRun: (at: number, first: number) => boolean,
  open: (run: Row[]) => boolean,
  branch: (first: Row) => Branch,
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
    if (folded) listed.push({ kind: "fold", key: run[0]!.key, rows: run, branch: branch(run[0]!) });
    index += run.length;
  }
  return { rows: listed, placeOf };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((key, at) => key === b[at]);

// The keys of the rows listed, in order, and each key's place among them.
function keysOf(keys: string[], places: Map<string, number>): Keys {
  return { at: (index) => keys[index]!, indexOf: (key) => places.get(key) };
}
const listedKeysOf = (keys: string[], measured: string[], places: Map<string, number>): ListedKeys => ({ ...keysOf(keys, places), measuredBy: (index) => measured[index]! });

// [LAW:types-are-the-program] What each level shows of its category's blocks (docs/design/01-mvp.md, F4, F5): whether
// they are listed, and whether each starts expanded. The compiler asks for an entry for each level.
const levels: Record<Visibility, { listed: boolean; startsExpanded: boolean }> = {
  hidden: { listed: false, startsExpanded: false },
  compact: { listed: true, startsExpanded: false },
  expanded: { listed: true, startsExpanded: true },
};

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
      return fieldLines(part.fields).reduce((length, { name, value }) => length + name.length + (value?.length ?? 0), 0);
    case "media":
      return part.source.type === "base64" ? part.source.data.length : part.source.type === "url" ? part.source.url.length : part.source.file_id.length;
    // An edit holds its two texts; its lines are not diffed to count them.
    case "diff":
      return part.before.length + part.after.length;
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

// What a block's line shows after its name (docs/design/02-design.md, "Print what varies"): the start of what its
// `preview` reads as, or, for a block with none, of its first part with anything to read, on one line, as much as a line
// could hold, and an ellipsis where it was cut. A block of media alone shows nothing. Read once per block, which the
// formatter keeps the same object while its side of the exchange is unchanged: a text is read as rendered whole, once
// per text however many parts hold it (view/rendering.ts).
const previews = new WeakMap<Block, string>();
export function preview(block: Block): string {
  const line = previews.get(block) ?? previewLine(block);
  previews.set(block, line);
  return line;
}
function previewLine(block: Block): string {
  const text = (block.preview ?? block.parts).values().map(partText).find((text) => /\S/.test(text)) ?? "";
  // What it reads is collapsed only a few lines' worth ahead, enough to fill the line once its whitespace is collapsed;
  // each cut is at a whole character, not between a surrogate pair's halves, and the ellipsis says something visible was
  // cut.
  const scanned = wholeCut(text, previewLength * 4);
  const collapsed = scanned.replace(/\s+/g, " ").trim();
  const line = wholeCut(collapsed, previewLength);
  return line.length < collapsed.length || /\S/.test(text.slice(scanned.length)) ? `${line.trimEnd()}…` : line;
}
const previewLength = 200;

// A part's text, as its line reads it. A text reads as its rendering shows it (view/rendering.ts), so a Markdown text's
// syntax is not read, each passage apart from the next. A JSON string, as a tool's input is while it streams, is its own
// text; any other value reads as a field would show it (format/parts.ts).
function partText(part: Part): string {
  switch (part.kind) {
    case "text": {
      const { text, passages } = renderingOf(part);
      return passages.map(({ start, end }) => text.slice(start, end)).join(" ");
    }
    case "json":
      return typeof part.value === "string" ? part.value : leafText(fieldValue(part.value));
    case "fields":
      return leafText(part.fields);
    case "media":
      return "";
    case "diff":
      return diffOf(part).text;
  }
}

// A value as one run of its leaves: each by its path, the names holding it joined by dots, and its value. A null holds
// nothing to read, so it is left out, whether a field holds it or it is the whole value.
function leafText(value: Field[1], path: string[] = []): string {
  return typeof value !== "string" ? value.map(([name, member]) => leafText(member, [...path, name])).join("  ") : value === "null" ? "" : `${path.join(".")} ${value}`;
}

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

// A model as the exchange line names it: without the "claude-" every Anthropic model id starts with, which never varies
// (docs/design/02-design.md, "Print what varies"). An id in another scheme is named whole.
export const modelName = (model: string): string => model.replace(/^claude-/, "");

// A duration in milliseconds as seconds to one decimal.
export function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

// [LAW:one-source-of-truth] The exchange line's facts that the turn strip's marks say too (view/strip.ts): an HTTP
// status that is an error's, and the token counts, by label.
export const statusFailed = (status: number | undefined): boolean => status !== undefined && status >= 400;
export const countsOf = (facts: FormattedExchange["facts"]): [label: string, count: number | undefined][] => [
  ["in", facts.input],
  ["cache", facts.cacheRead],
  ["written", facts.cacheWritten],
  ["out", facts.output],
];

// [LAW:one-source-of-truth] Whether a block's row starts expanded, before any choice of the reader's (isOpen). A block
// starts as its category's level says, but what the harness injected into a message starts collapsed, since it is not
// what was said (docs/design/01-mvp.md, F4), and so do a block a step took away, which is no longer part of the
// conversation, and a block of a hidden category the search revealed.
export function startsExpanded(row: BlockRow, visibility: Record<Category, Visibility>): boolean {
  const { category, injected } = blockOf(row);
  return injected === undefined && !isGone(row) && levels[visibility[category]].startsExpanded;
}

// [LAW:one-source-of-truth] Whether the sections under the headings of a block's texts start open, before any choice of
// the reader's (docs/design/01-mvp.md, F4): what the user or the assistant said or thought reads whole, as it was
// written, each heading a place to fold it; what was written for the model, its prompt, a tool's description and what
// the harness injected, starts as its outline, each heading a line that opens.
export const sectionsStartOpen = ({ category, injected }: Block): boolean =>
  injected === undefined && (category === "user" || category === "assistant" || category === "thinking");

// [LAW:one-source-of-truth] Whether a set starts open, before any choice of the reader's: as the level of its blocks'
// category says, so at compact it is its one line, and at expanded its blocks are listed (docs/design/01-mvp.md, F4).
export const setStartsOpen = (category: Category, visibility: Record<Category, Visibility>): boolean => levels[visibility[category]].startsExpanded;

// The set a block's row is in that shows closed, by its line's key: none for a row of no set, or of a set that shows
// open, as the reader chose or else as it starts.
export const closedSetOf = (row: BlockRow, visibility: Record<Category, Visibility>, opened: Opened): string | undefined =>
  row.set === undefined || isOpen(opened, row.set, setStartsOpen(blockOf(row).category, visibility)) ? undefined : row.set;

// The key the virtualizer keeps a row's measured height by: what decides that height, the row's key and, for a block's
// row, whether it shows open, as its level starts it or as the reader chose. A height measured open is never read for
// the row closed, whichever level or choice closes it.
export const measuredBy = (row: Row, visibility: Record<Category, Visibility>, opened: Opened): string =>
  row.kind === "block" ? `${row.key}#${showsOpen(row, visibility, opened) ? "open" : "closed"}` : row.key;

// [LAW:one-source-of-truth] Whether a block's row shows open: as the reader chose, or else as its level starts it.
export const showsOpen = (row: BlockRow, visibility: Record<Category, Visibility>, opened: Opened): boolean =>
  isOpen(opened, row.key, startsExpanded(row, visibility));

// A row's height before it is measured, in pixels: one line, an exchange's band with the space above it, or an expanded
// block's line and its content at about 100 characters a line. Only rows not yet on screen use it, so it decides how the
// scrollbar reads, not where anything lands.
export function estimateHeight(row: Row, opened: Opened, visibility: Record<Category, Visibility>): number {
  const line = 20;
  switch (row.kind) {
    case "exchange":
      return 52;
    case "group":
    case "set":
    case "fold":
      return line;
    case "block":
      return showsOpen(row, visibility, opened) ? line + Math.ceil(sizeOf(blockOf(row)) / 100) * 16 : line;
  }
}
