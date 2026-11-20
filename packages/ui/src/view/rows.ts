import type { Block, Category } from "../format/blocks.ts";
import { diffOf } from "../format/diff.ts";
import { fieldLines, fieldValue, jsonText, type Field, type Part } from "../format/parts.ts";
import type { FormattedExchange, Heading, KeyedBlock } from "../format/format.ts";
import type { Visibility } from "../settings.ts";
import type { Launch } from "../format/blocks.ts";
import { forksOf, levelKey, main, placeOf, sameFields, type After, type Agent, type Call, type History, type Item, type Level, type Made, type Segment, type Version } from "./history.ts";
import { renderingOf } from "./rendering.ts";

// The conversation at a moment as the rows the view lists, one line or one block each, in one column
// (docs/design/02-design.md, "Two axes").

// What a step did to a row: brought it (`added`), left it as it was (`same`), gave its item a new version
// (`changed`), or took it away (`removed`).
export type Change = "added" | "same" | "changed" | "removed";
// [LAW:one-source-of-truth] The theme's variable for what a step did to a row, which colors the band at its edge and
// its mark on the minimap; none for a row left as it was.
export const changeColors: Record<Change, `--${string}` | undefined> = { added: "--success", changed: "--warning", removed: "--error", same: undefined };

// [LAW:types-are-the-program] A row's key names what it shows: an exchange's line its trace_id, a group's title or a
// set's line `<trace_id>/<group key>`, a block its item's key (view/history.ts), and a fork's, a nest's or a thread's
// line the key of what it stands after and its kind (`<trace_id>/fork`, `<item's key>/nest`), so it is the same row at
// every moment and however many rows arrive around it. `change`: what the step shown did to the row, which brings an
// exchange's line and a group's title or leaves them, and rewrites or takes away a block alone. A block's row shows
// one version of its item, the last a step the column lists gave it, `versions[at]`: its block, or, once a step took
// the item away, the block it was, which stays listed at its place (blockOf). `versions` is the item's own, the same
// array while the item gets no version, so a row made again as it was has the fields it had. `set`: the key of the
// set's line a block is listed under, for one of a set. Every row says how it stands in the column (Standing).
export type Row =
  | ({ kind: "exchange"; key: string; exchange: FormattedExchange; change: "added" | "same" } & Standing)
  | ({ kind: "group"; key: string; title: Heading; change: "added" | "same" } & Standing)
  | SetRow
  | BlockRow
  | ForkRow
  | NestRow
  | ThreadRow;
export type BlockRow = { kind: "block"; key: string; change: Change; versions: readonly Version[]; at: number; set: string | undefined } & Standing;
// How a row stands in the column: `depth`, how many Agent calls it is under, each a level in; and whether it is
// `dimmed`, as a row of the steps a compaction's summary replaced is once the thread that carries the summary on is
// listed (columnOf).
export type Standing = { depth: number; dimmed: boolean };
// [LAW:types-are-the-program] A set's line: the title of a group whose blocks are a set, blocks of one kind and one
// category that read as one thing, as a request's tool definitions do. It stands for them while it is closed, when
// none of them is listed, and over them while it is open (docs/design/01-features.md, F4). It holds the group's `items`,
// the history's own array, and the step shown and the `steps` the column lists, which its blocks' rows are read from
// (blocksOf), so it is the same fields while none of its items gets a version. `change`: what the step shown did to
// the set, which brings it, leaves it, or changes it, by doing anything to a block of it.
export type SetRow = { kind: "set"; key: string; title: Heading; change: "added" | "same" | "changed"; items: readonly Item[]; step: number; steps: ReadonlySet<number> } & Standing;
// [LAW:types-are-the-program] The line where histories part (docs/design/02-design.md, "Two axes"): it stands after
// what two or more steps of the recording stand after, a step's rows or the line of a nest or a thread, and lists
// those siblings, each by its step, with the one the column lists, `shown`: none before the first of them arrives.
// It stands above every sibling's rows, so no row above it moves when the reader switches. No step brings or changes
// it: it says what the recording holds.
export type ForkRow = { kind: "fork"; key: string; change: "same"; siblings: readonly Sibling[]; shown: number | undefined } & Standing;
export type Sibling = { step: number; preview: string };
// [LAW:types-are-the-program] A nest's line: a subagent, by its `agent` id, which holds the subagent's rows, one level
// in, closed until the reader opens it (Opened, by this row's key, which is the agent's, so the same at every moment).
// It stands right after the Agent call whose result names it, from the step that result arrives, and says what the
// call launched, its `launch`; before that, at the end of its parent's level, with none: not yet tied to a call
// (standsAt). It says the `count` of its steps the column lists, whether it `runs` at the step shown and, of what it
// did while it runs, the `latest` (doingOf). `change`: the step shown brought the subagent's first step, is another
// step inside the nest, or neither.
export type NestRow = {
  kind: "nest";
  key: string;
  change: "added" | "same" | "changed";
  agent: string;
  launch: Launch | undefined;
  count: number;
  runs: boolean;
  latest: KeyedBlock | undefined;
} & Standing;
// A thread's line: after the block whose summary a compaction's next thread begins with, where the thread above, now
// dimmed, ends and the thread that carries it on begins, at the same depth. `change`: whether the step shown is the
// new thread's first.
export type ThreadRow = { kind: "thread"; key: string; change: "added" | "same" } & Standing;

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

// A block's past at the step shown: what each step on the path to the version shown did to its item since it arrived,
// in order, each version saying the one it came after (view/history.ts). None for a block as it arrived, which is
// nearly every one.
export function pastOf({ versions, at }: BlockRow): Event[] {
  const events: Event[] = [];
  for (let index: number | undefined = at; index !== undefined && index > 0; index = versions[index]!.previous) events.unshift(eventOf(versions[index]!));
  return events;
}

// The last of a block's past, read without listing it: what the version shown did, but for a block as it arrived.
export const lastOf = ({ versions, at }: BlockRow): Event | undefined => (at === 0 ? undefined : eventOf(versions[at]!));

// Whether a step took a block's item away by the step shown: its row shows the block it was.
export const isGone = ({ versions, at }: BlockRow): boolean => versions[at]!.block === undefined;

// A row's mark on the minimap: what the step shown did to it, or, where it left it as it was, the last thing a step did
// to it since it arrived, so a block rewritten or taken away is marked at every step after.
export function markOf(row: Row): Change {
  if (row.change !== "same") return row.change;
  return row.kind === "block" ? (lastOf(row)?.change ?? "same") : row.kind === "set" ? (summaryOf(row).last?.event.change ?? "same") : "same";
}

// The rows of a set's blocks at the step it shows, in order: listed under its line while it is open.
export const blocksOf = ({ key, items, step, steps, depth, dimmed }: SetRow): BlockRow[] => items.map((item) => itemRow(item, step, steps, key, { depth, dimmed }));

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

// The rows of the conversation at a moment, and their keys: those listed, which leave out what a closed nest holds and,
// of each step's own rows, those shownOf does not list; `every` row, listed or not, which the search reads, since a
// hidden category's blocks, a closed set's and a closed nest's are searched (docs/design/01-features.md, F6); and the
// `steps` the column lists, whose rows these are (columnOf).
export type Layout = { rows: Row[]; keys: ListedKeys; every: { rows: Row[]; keys: Keys }; steps: ReadonlySet<number> };

// The rows' keys in order: the key at an index, and the index of a key: of its row, or, for a row not listed, of the
// row listed before it, whose end is where it stands: a closed nest's line, for a row the nest holds.
// [LAW:types-are-the-program] The same object while no row, listed or not, arrives, goes or moves, so what reads rows
// by key reads them again only when one did.
export type Keys = { at: (index: number) => string; indexOf: (key: string) => number | undefined };
// The keys of the rows listed, which the virtualizer places, and the key it keeps each one's measured height by
// (measuredBy): the same object, too, while no row's height is measured by another key.
export type ListedKeys = Keys & { measuredBy: (index: number) => string };

// [LAW:one-source-of-truth] What the reader chose to show of each block, region or nest they opened or closed, by key:
// open, or closed. A key with no choice shows as it starts. A choice is kept as made, the same as how the key starts now
// or not, since how a block starts moves with its category's level and the choice outlasts a change of level
// (docs/design/01-features.md, F4).
export type Opened = Record<string, boolean>;
export const isOpen = (opened: Opened, key: string, starts: boolean): boolean => opened[key] ?? starts;

// The key a block's past is opened by, by its row's key: a choice of its own, which starts closed whatever the block's
// level, since a block rewritten at most steps holds as many diffs.
export const pastKey = (key: string) => `past:${key}`;

// Lays out the conversation at step `step` of `history`: the rows of each step the column lists then (columnOf), a
// level's in the order its steps arrived, a subagent's under the line of the call that launched it, which holds them
// closed until the reader opens it (`opened`), and of each step's own rows those shownOf lists, by the levels
// `visibility`, the reader's choices and the key `currentKey` of the search's current match. A step of 0 is the
// conversation before anything arrived.
export function createLayout(visibility: Record<Category, Visibility>): (history: History, step: number, currentKey: string | undefined, opened: Opened) => Layout {
  let last: Layout = { rows: [], keys: listedKeysOf([], [], new Map()), every: { rows: [], keys: keysOf([], new Map()) }, steps: new Set() };
  // Each fork's siblings as its line last listed them, by its key.
  let forks = new Map<string, readonly Sibling[]>();
  return (history, step, currentKey, opened) => {
    const { segments } = history;
    const column = columnOf(history, step);
    // [LAW:one-source-of-truth] The steps listed are the set they were while they are the same steps, and a fork's
    // siblings the array they were while each says the same, so a row that holds either is made again with the fields
    // it had.
    const steps = column.steps.size === last.steps.size && [...column.steps].every((own) => last.steps.has(own)) ? last.steps : column.steps;
    const listedForks = new Map<string, readonly Sibling[]>();
    const every: Row[] = [];
    const isShown: boolean[] = [];
    const list = (row: Row, shown: boolean) => {
      every.push(row);
      isShown.push(shown);
    };
    // [LAW:one-source-of-truth] Whether each of a step's rows is listed. A block counts where its level lists it
    // (docs/design/01-features.md, F5) or it is the search's current match (F6), and is listed while its set, if any,
    // shows open (F4). A title, a group's or a set's, is listed over any block that counts, its set open or closed, so a
    // closed set's line stays the control that opens it: read from the end, whether one follows before the next title.
    const shownOf = (rows: Own[]): boolean[] => {
      const shown = rows.map(() => true);
      let titled = false;
      for (let index = rows.length - 1; index >= 0; index--) {
        const row = rows[index]!;
        if (row.kind === "block") {
          const levelLists = levels[visibility[blockOf(row).category]].listed;
          const listedBy = levelLists || row.key === currentKey;
          const setOpen = row.set === undefined || isOpen(opened, row.set, setStartsOpen(blockOf(row).category, visibility));
          shown[index] = listedBy && setOpen;
          titled ||= listedBy;
          continue;
        }
        if (row.kind !== "exchange") shown[index] = titled;
        titled = false;
      }
      return shown;
    };
    // The line of the fork at `place`, where the recording has siblings part there.
    const fork = (place: string, standing: Standing, open: boolean) => {
      const siblings = column.forks.get(place);
      if (siblings === undefined) return;
      const key = `${place}/fork`;
      const made = siblings.map((own) => siblingOf(segments[own - 1]!, own));
      const before = forks.get(key);
      const kept = before !== undefined && before.length === made.length && made.every((one, index) => sameFields(one, before[index]!)) ? before : made;
      listedForks.set(key, kept);
      list({ kind: "fork", key, change: "same", siblings: kept, shown: column.shown.get(place), ...standing }, open);
    };
    // [LAW:dataflow-not-control-flow] A nest's line, which stands as the row it follows does, then, one level in and
    // listed while the nest is open, the rows of its subagent's level.
    const nest = (agent: string, standing: Standing, open: boolean) => {
      const key = nestKey(agent);
      list(nestRow(agent, column, step, standing), open);
      level(levelKey({ kind: "agent", id: agent }), { ...standing, depth: standing.depth + 1 }, open && isOpen(opened, key, nestStartsOpen));
    };
    // A thread's line, after the block whose summary the threads that carry it on begin with, then the fork of those
    // threads, which stand as the level does: the thread's line is where what is dimmed ends.
    const thread = (block: BlockRow, around: Standing, open: boolean) => {
      list({ kind: "thread", key: `${block.key}/thread`, change: column.shown.get(block.key) === step ? "added" : "same", ...around }, open);
      fork(block.key, around, open);
    };
    // The rows of a level's steps, in the order the steps arrived: each step's own, after a block of them the thread
    // that carries its summary on and the nests that stand under it, and the fork of the steps that follow it after
    // them all; then the nests that stand at the level's end. `open`: whether no nest they are in is closed.
    const level = (key: string, around: Standing, open: boolean) => {
      for (const own of column.levels.get(key) ?? []) {
        const segment = segments[own - 1]!;
        const standing = { depth: around.depth, dimmed: around.dimmed || column.dimmed.has(own) };
        const rows = segmentRows(segment, own, step, steps, standing);
        const shown = shownOf(rows);
        rows.forEach((row, index) => {
          list(row, open && shown[index]!);
          if (row.kind !== "block") return;
          if (column.hung.has(row.key)) thread(row, around, open);
          for (const agent of column.under.get(row.key) ?? []) nest(agent, standing, open);
        });
        fork(segment.formatted.exchange.trace_id, standing, open);
      }
      for (const agent of column.ending.get(key) ?? []) nest(agent, around, open);
    };
    level(levelKey(main), { depth: 0, dimmed: false }, true);
    forks = listedForks;

    const rows = every.filter((_, index) => isShown[index]);
    // Each row's place among those listed: its own, or the place of the row listed before it.
    const places = new Map<string, number>();
    let before = 0;
    let count = 0;
    every.forEach((row, index) => {
      if (isShown[index]) before = count++;
      places.set(row.key, before);
    });
    const listedKeys = rows.map(({ key }) => key);
    const listedMeasured = rows.map((row) => measuredBy(row, visibility, opened));
    const everyKeys = every.map(({ key }) => key);
    const sameKeys = same(everyKeys, last.every.rows.map(({ key }) => key));
    const sameEvery = sameKeys && every.every((row, index) => versionOf(row) === versionOf(last.every.rows[index]!));
    last = {
      rows,
      // What a row shows changing, as a streaming block does, moves no row, so the keys are the ones before.
      keys:
        sameKeys && same(listedKeys, last.rows.map(({ key }) => key)) && listedMeasured.every((key, index) => key === last.keys.measuredBy(index))
          ? last.keys
          : listedKeysOf(listedKeys, listedMeasured, places),
      // [LAW:one-source-of-truth] The search reads of every row the version it shows alone, its block and whether a
      // step took it away, so the same versions are the same `every`, and what memoizes on it is not run again by a
      // step of the search or of time that changed none.
      every: sameEvery ? last.every : { rows: every, keys: keysOf(everyKeys, new Map(everyKeys.map((key, index) => [key, index]))) },
      steps,
    };
    return last;
  };
}

// The column at a moment (docs/design/02-design.md, "Two axes"). Every step stands after one thing, a step or a summary
// (view/history.ts), and the steps after one thing are siblings: histories that part there. The column lists one
// history, so of the siblings that have arrived by the moment at each place it lists one, the one under which the
// latest step by the moment stands, which is the chosen step's own wherever its path passes; and a step is listed when
// it is the one listed at its place and what it stands after is listed. A step that stands after nothing is always
// listed. `steps`: those listed. `levels`: each level's, by its key, in the order they arrived. `stands`: where each
// subagent whose first step has arrived stands (standsAt); `under`, those under each call, by the key of the call's item
// the column lists,
// and `ending`, those at the end of each level, by its key. `inside`: the subagents whose nests the chosen step is in.
// `forks`: the siblings at each place where the recording has two or more, arrived or not, as the strip marks every
// step (view/strip.ts), so a line where histories part lists each it can switch to. `shown`: the sibling listed at each
// place. `hung`: the summaries a listed step carries on, by their blocks' keys. `dimmed`: the listed steps a thread
// that is listed carries on from, which its summary replaced. `doing`: what each subagent that runs at the moment
// did (`doingOf`).
type Column = {
  steps: Set<number>;
  levels: Map<string, number[]>;
  stands: Map<string, Stand>;
  under: Map<string, string[]>;
  ending: Map<string, string[]>;
  inside: Set<string>;
  forks: Map<string, number[]>;
  shown: Map<string, number>;
  hung: Set<string>;
  dimmed: Set<number>;
  doing: Map<string, Doing>;
};

// [LAW:types-are-the-program] Where a subagent stands: `under` the call the wire names as its launcher, with what the
// call launched; or at the `ending` of its parent's level, not yet tied to a call.
export type Stand = { under: Call } | { ending: Level };
// [LAW:no-ambient-temporal-coupling] Where a subagent stands at step `step`: under its call from the step whose request
// first carries the result that names it, and at the end of its parent's level before, as the wire has said by then.
export const standsAt = ({ named, parent }: Agent, step: number): Stand => (named !== undefined && named.step <= step ? { under: named.call } : { ending: parent });

// The key of a subagent's nest's line, by its agent's id.
export const nestKey = (agent: string) => `nest:${agent}`;
// [LAW:one-source-of-truth] A nest starts closed: the reader opens it, and it stays as they left it.
export const nestStartsOpen = false;

function columnOf({ segments, agents, made }: History, step: number): Column {
  const places = segments.map(({ after }) => (after === undefined ? undefined : placeOf(after, segments)));
  const add = <K, V>(lists: Map<K, V[]>, key: K, one: V) => lists.set(key, lists.get(key) ?? []).get(key)!.push(one);
  const arrived = segments.slice(0, step);
  // The latest step by the moment under each step, itself or one that stands after it or after a block of it and so
  // on: those are all later than it, so, read from the last, each has its own before it is counted for the one it
  // stands after.
  const latest = [0, ...arrived.map((_, index) => index + 1)];
  arrived.forEach((_, index, { length }) => {
    const own = length - index;
    const after = arrived[own - 1]!.after;
    if (after !== undefined) latest[after.step] = Math.max(latest[after.step]!, latest[own]!);
  });
  const shown = new Map<string, number>();
  arrived.forEach((_, index) => {
    const place = places[index];
    if (place !== undefined && latest[index + 1]! > latest[shown.get(place) ?? 0]!) shown.set(place, index + 1);
  });
  const steps = new Set<number>();
  const levels = new Map<string, number[]>();
  const hung = new Set<string>();
  const dimmed = new Set<number>();
  arrived.forEach(({ after, level }, index) => {
    const own = index + 1;
    if (after !== undefined && (!steps.has(after.step) || shown.get(places[index]!) !== own)) return;
    steps.add(own);
    add(levels, levelKey(level), own);
    if (after?.on !== "summary") return;
    hung.add(after.key);
    // What a thread carries on: the step whose summary it begins with, and each that one follows or carries on, up
    // to the first of its level.
    for (let on: After | undefined = after; on !== undefined && !dimmed.has(on.step); on = arrived[on.step - 1]!.after) dimmed.add(on.step);
  });
  const stands = new Map<string, Stand>();
  for (const [id, agent] of agents) if (agent.first <= step) stands.set(id, standsAt(agent, step));
  // A subagent's steps are listed where what it stands in is: the item of its call a listed step of a listed level
  // made, or its parent's level. One whose call only a sibling history made is that history's, not the one listed.
  // [LAW:no-silent-failure] One that stands, through its calls, in itself is listed nowhere: it is marked unlisted
  // before what it stands in is read.
  const listed = new Map<string, Made | Level | undefined>();
  const standing = (id: string): Made | Level | undefined => {
    if (listed.has(id)) return listed.get(id);
    listed.set(id, undefined);
    const stand = stands.get(id)!;
    const isListed = (level: Level) => level.kind === "main" || standing(level.id) !== undefined;
    const found = "under" in stand ? (made.get(stand.under.id) ?? []).find((one) => steps.has(one.step) && isListed(segments[one.step - 1]!.level)) : isListed(stand.ending) ? stand.ending : undefined;
    listed.set(id, found);
    return found;
  };
  const under = new Map<string, string[]>();
  const ending = new Map<string, string[]>();
  for (const id of stands.keys()) {
    const found = standing(id);
    if (found !== undefined) {
      if ("key" in found) add(under, found.key, id);
      else add(ending, levelKey(found), id);
      continue;
    }
    const level = levelKey({ kind: "agent", id });
    for (const own of levels.get(level) ?? []) steps.delete(own);
    levels.delete(level);
  }
  // The nests the chosen step is in: its level's, then the level its nest stands in, and so on out.
  const inside = new Set<string>();
  for (let level: Level = arrived[step - 1]?.level ?? main; level.kind === "agent"; ) {
    inside.add(level.id);
    const found = standing(level.id)!;
    level = "key" in found ? segments[found.step - 1]!.level : found;
  }
  return { steps, levels, stands, under, ending, inside, forks: forksOf(segments), shown, hung, dimmed, doing: doingOf(arrived, agents) };
}

// What a subagent that runs at the moment did: the last block of its newest reply that waits and has one, or none yet.
export type Doing = { latest: KeyedBlock | undefined };

// Each subagent that runs at the moment, step `arrived.length`, and what it did. [LAW:no-ambient-temporal-coupling]
// All of it is as it stood then: a reply of a subagent waits while it is still coming at the moment, its exchange not
// ended by the time the step shown ended (an open step's: now), or while it stopped for a tool's use with a call, not
// its SubagentHandback (format/blocks.ts), that no request of the subagent by the moment sends a result for, matched
// by the call's id; and a stop that names the subagent after such a reply, by the moment, ends its wait. So a request
// that resends a waiting step with no result, as the harness's question of what a subagent is doing does, answers
// nothing (docs/design/claude-code-wire.md). A subagent runs while a reply of its waits. A reply with no block yet says
// nothing, so one sent beside a reply still coming does not take the line from it.
function doingOf(arrived: readonly Segment[], agents: ReadonlyMap<string, Agent>): Map<string, Doing> {
  const step = arrived.length;
  const ended = arrived.at(-1)?.formatted.exchange.end;
  const moment = ended === undefined ? Infinity : Date.parse(ended.timestamp);
  const answered = new Map<string, Set<string>>();
  for (const { level, groups } of arrived) {
    if (level.kind !== "agent") continue;
    for (const { versions } of groups.flatMap(({ items }) => items)) {
      const { stated } = versions[0]!.block!;
      if (stated?.kind === "result") answered.set(level.id, (answered.get(level.id) ?? new Set()).add(stated.answers));
    }
  }
  const doing = new Map<string, Doing>();
  arrived.forEach(({ level, formatted: { exchange, facts, groups } }, index) => {
    if (level.kind !== "agent") return;
    const reply = groups.flatMap(({ blocks }) => blocks).filter(({ place }) => place?.in === "reply");
    const coming = exchange.end === undefined || Date.parse(exchange.end.timestamp) > moment;
    const onTool = facts.stopReason === "tool_use" && reply.some(({ stated }) => stated?.kind === "call" && stated.tool.name !== "SubagentHandback" && !answered.get(level.id)?.has(stated.id));
    const stopped = agents.get(level.id)!.stops.some((at) => at > index + 1 && at <= step);
    if ((coming || onTool) && !stopped) doing.set(level.id, { latest: reply.at(-1) ?? doing.get(level.id)?.latest });
  });
  return doing;
}

// A row a step lists of its own: its exchange's line, a group's title, a set's line, or a block.
type Own = Extract<Row, { kind: "exchange" | "group" | "set" | "block" }>;

// The rows of step `own`'s segment at step `step`: its exchange's line, then each group's items' rows, under its title
// where it has one and an item: a set's line, for a group whose blocks are a set.
function segmentRows({ formatted, groups }: Segment, own: number, step: number, steps: ReadonlySet<number>, standing: Standing): Own[] {
  const change = own === step ? "added" : "same";
  const trace = formatted.exchange.trace_id;
  return [
    { kind: "exchange", key: trace, exchange: formatted, change, ...standing },
    ...groups.flatMap(({ key: group, title, items }): Own[] => {
      const key = `${trace}/${group}`;
      if (title === undefined || items.length === 0) return items.map((item) => itemRow(item, step, steps, undefined, standing));
      if (!sets.has(title)) return [{ kind: "group", key, title, change, ...standing }, ...items.map((item) => itemRow(item, step, steps, undefined, standing))];
      const set: SetRow = { kind: "set", key, title, change, items, step, steps, ...standing };
      const blocks = blocksOf(set);
      return [{ ...set, change: change === "same" && blocks.some((block) => block.change !== "same") ? "changed" : change }, ...blocks];
    }),
  ];
}

// An item's row at step `step`, a step at or after the one it arrived at, in a column that lists `steps`: the last
// version a step listed gave it, and what the step shown did to it if that version is the step's. A version of a
// sibling's is of a step not listed, so no row shows it. `set`: the key of the set's line it is listed under, if any.
function itemRow({ key, versions }: Item, step: number, steps: ReadonlySet<number>, set: string | undefined, standing: Standing): BlockRow {
  const at = versions.findLastIndex((version) => steps.has(version.step));
  return { kind: "block", key, change: versions[at]!.step === step ? eventOf(versions[at]!).change : "same", versions, at, set, ...standing };
}

// The line of subagent `agent`'s nest at step `step`.
function nestRow(agent: string, column: Column, step: number, standing: Standing): NestRow {
  const steps = column.levels.get(levelKey({ kind: "agent", id: agent }))!;
  const stand = column.stands.get(agent)!;
  const doing = column.doing.get(agent);
  return {
    kind: "nest",
    key: nestKey(agent),
    change: steps[0] === step ? "added" : column.inside.has(agent) ? "changed" : "same",
    agent,
    launch: "under" in stand ? stand.under.launch : undefined,
    count: steps.length,
    runs: doing !== undefined,
    latest: doing?.latest,
    ...standing,
  };
}

// A sibling as its fork's line lists it: its step, and the start of the first thing it says of its own, what the user
// said where it brought that, or else the first block it brought to a message or as its reply.
function siblingOf({ groups }: Segment, step: number): Sibling {
  const own = groups.flatMap(({ items }) => items.map(({ versions }) => blockIn(versions[0]!))).filter(({ place }) => place?.in === "message" || place?.in === "reply");
  const said = own.find(({ category, injected }) => category === "user" && injected === undefined) ?? own[0];
  return { step, preview: said === undefined ? "" : preview(said) };
}

// The nests the row at `index` of `rows` is inside, by their lines' keys, the innermost first: going back, each is the
// first nest's line that stands further out than the last.
export function nestsOf(rows: readonly Row[], index: number): string[] {
  const keys: string[] = [];
  let depth = rows[index]!.depth;
  for (let at = index - 1; at >= 0 && depth > 0; at--) {
    const row = rows[at]!;
    if (row.kind !== "nest" || row.depth >= depth) continue;
    keys.push(row.key);
    depth = row.depth;
  }
  return keys;
}

// The version a row shows, which only a block's row does.
const versionOf = (row: Row) => (row.kind === "block" ? row.versions[row.at] : undefined);

const same = (a: string[], b: string[]) => a.length === b.length && a.every((key, at) => key === b[at]);

// The keys of the rows listed, in order, and each key's place among them.
function keysOf(keys: string[], places: Map<string, number>): Keys {
  return { at: (index) => keys[index]!, indexOf: (key) => places.get(key) };
}
const listedKeysOf = (keys: string[], measured: string[], places: Map<string, number>): ListedKeys => ({ ...keysOf(keys, places), measuredBy: (index) => measured[index]! });

// [LAW:types-are-the-program] What each level shows of its category's blocks (docs/design/01-features.md, F4, F5): whether
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
// what was said (docs/design/01-features.md, F4), and so do a block a step took away, which is no longer part of the
// conversation.
export function startsExpanded(row: BlockRow, visibility: Record<Category, Visibility>): boolean {
  const { category, injected } = blockOf(row);
  return injected === undefined && !isGone(row) && levels[visibility[category]].startsExpanded;
}

// [LAW:one-source-of-truth] Whether the sections under the headings of a block's texts start open, before any choice of
// the reader's (docs/design/01-features.md, F4): what the user or the assistant said or thought reads whole, as it was
// written, each heading a place to fold it; what was written for the model, its prompt, a tool's description and what
// the harness injected, starts as its outline, each heading a line that opens.
export const sectionsStartOpen = ({ category, injected }: Block): boolean =>
  injected === undefined && (category === "user" || category === "assistant" || category === "thinking");

// [LAW:one-source-of-truth] Whether a set starts open, before any choice of the reader's: as the level of its blocks'
// category says, so at compact it is its one line, and at expanded its blocks are listed (docs/design/01-features.md, F4).
export const setStartsOpen = (category: Category, visibility: Record<Category, Visibility>): boolean => levels[visibility[category]].startsExpanded;

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
    case "fork":
    case "nest":
    case "thread":
      return line;
    case "block":
      return showsOpen(row, visibility, opened) ? line + Math.ceil(sizeOf(blockOf(row)) / 100) * 16 : line;
  }
}
