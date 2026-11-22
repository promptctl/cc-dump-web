import type { Block } from "../format/blocks.ts";
import type { Launch } from "../format/tools.ts";
import { equal } from "../equal.ts";
import type { Part } from "../format/parts.ts";
import type { FormattedExchange, Group, KeyedBlock, Place } from "../format/format.ts";
import type { Sender } from "../format/wire.ts";
import { followsOf, type Fact } from "./lines.ts";

// The conversation through time (docs/design/02-design.md, "Two axes"). A step is an exchange, in the order exchanges
// began, a turn, a quota probe, a title request and a subagent's request alike, and the conversation at step k is what
// exchanges 1..k brought to it. Each request resends its thread's history, so an item of the conversation is not a
// request's block but a block at its place in a thread: it enters with the exchange it first arrives with and stays
// there, resending it adds nothing, and different content at its place is a new version of it.

// A version of an item: the block at its place from `step` on, whether it arrived as a reply, which is compared with
// the block the next request resends as that block is, and the block it `rewrote`, the one its place last held, where
// this one's content is another's: none for the item's first, and for one sent again as it was after a step took it
// away. [LAW:one-source-of-truth] So what a version did to its item is said here alone, by the comparison that made it
// a version. Or none once a request no longer sends it, `was` the block it stopped sending.
// [LAW:types-are-the-program] The requests of a thread part ways (view/lines.ts), so an item's versions are not one
// line either: each says the one it came after, `previous`, its index among them, which is the item's version on the
// path of the step that made it, the steps that step follows. None for the item's first, which is always a block sent.
export type Version = (Sent & { rewrote: KeyedBlock | undefined }) | Gone;
type Sent = { step: number; block: KeyedBlock; reply: boolean; previous: number | undefined };
type Gone = { step: number; block: undefined; was: KeyedBlock; previous: number };

// [LAW:types-are-the-program] Whose a step is: the main agent's, a subagent's by its id, or the requests whose sender
// was not read (format/wire.ts), which are no agent's, so none of them is ever threaded, listed or summarized as the main
// agent's. Each level has threads of its own, and the steps of a level that follow nothing are its roots.
export type Level = { kind: "main" } | { kind: "agent"; id: string } | { kind: "unread" };
const main: Level = { kind: "main" };
const unread: Level = { kind: "unread" };
export const levelOf = (sender: Sender): Level => (sender.kind === "agent" ? { kind: "agent", id: sender.id } : sender.kind === "main" ? main : unread);
// A level as a key, a Map's or a row's (view/rows.ts, nestKey), the same string for the same level.
export const levelKey = (level: Level): string => (level.kind === "agent" ? `agent:${level.id}` : level.kind);

// [LAW:one-source-of-truth] What a step says on the wire about its level's agents (format/wire.ts), recorded once, as
// the step is folded, so moving back across the step takes it away with the step's segment and nothing reads it again
// out of the blocks: the column and the nest lines read these (view/rows.ts).
// Each fact is of the blocks the step brings to its path, new items and new versions alike, so a block it resends as its
// path holds it states nothing again. `level`: whose the step is. `opens`: for the first step of a subagent's level or
// of the unread one, the agent its parent header `names`, which the column places it under where that agent is
// recorded (view/rows.ts), and what its first message `says`, none while its request's body is not read.
// `ties`: each agent a result of an Agent call or a notification names with the call that launched it (Tie). `stops`:
// each agent a notification tells stopped, and how it ended. `answers`: the calls its results answer. `waits`: the
// calls its reply stopped for, each a call whose result it waits on. `did`: its reply's last block, none before its
// reply's first.
export type StepWire = {
  level: Level;
  opens: { names: string | undefined; says: string | undefined } | undefined;
  ties: readonly Tie[];
  stops: readonly { agent: string; status: string }[];
  answers: readonly string[];
  waits: readonly string[];
  did: KeyedBlock | undefined;
};
// [LAW:types-are-the-program] That a step names `agent` with the call that launched it, on the step's own level: the
// call's item, at `key`, and what it `launches`, found on the step's reach; or `found: false`, where no call of that id
// that launches anything is on its reach, which the agent's nest line says. A result names an agent only as the answer
// of an Agent call: one that answers a call of another tool on its reach, as a Bash that prints a result, names none.
export type Tie = { agent: string; call: string } & ({ found: true; key: string; launches: Launch } | { found: false });

// An item: its key, and each version it has had, in the order of their steps, the first the one it arrived with.
// [LAW:types-are-the-program] The key names the item, so it is the same at every moment: a thread's item is
// `thread:<trace>/tools/<block>` or `thread:<trace>/message.<i>/<block>`, by the exchange that first sent it and its
// place; named apart from any exchange's rows, since a key's `/` prefixes are the rows it stands inside (position.ts)
// and a thread's item stands inside none of them. What is an exchange's own is keyed as its row always was,
// `<trace>/<group>/<block>`.
export type Item = { key: string; versions: readonly Version[] };
// [LAW:one-source-of-truth] What a thread's item's key starts with, before its exchange's trace.
const threadPrefix = "thread:";
// The trace of the exchange an item's or a row's key starts with, as the keys are made here: after a thread's prefix,
// up to its first `/`. A key no exchange's trace begins, as a nest's line's, gives a trace no step has.
export const traceOf = (key: string): string => (key.startsWith(threadPrefix) ? key.slice(threadPrefix.length) : key).split("/", 1)[0]!;

// A step's part of the conversation: its exchange, each of its groups with the items that first arrived in it, what it
// stands `after`, and what it says of its level's agents (StepWire).
export type Segment = { formatted: FormattedExchange; groups: readonly ItemGroup[]; after: After | undefined; wire: StepWire };
export type ItemGroup = { key: string; title: Group["title"]; items: readonly Item[] };

// [LAW:types-are-the-program] What a step stands after, which is one thing: the step its request follows
// (view/lines.ts), or, for one whose request follows nothing, the reply's text whose summary its thread begins with,
// which it carries on as the `thread` after a compaction, the item at `key` in `step`'s segment. None for a root of
// its level, one that hangs on nothing. The steps that stand after one thing are siblings: the column lists one of
// them (view/rows.ts). Where a subagent's level stands is the moment's, not a step's (view/rows.ts, columnOf).
export type After = { step: number; on: "step" } | { step: number; on: "block"; key: string; as: "thread" };

// The place a step stands after, by name: the trace_id of the step it follows, or the key of the block it hangs on.
export const placeOf = (after: After, segments: readonly Segment[]): string => (after.on === "step" ? segments[after.step - 1]!.formatted.exchange.trace_id : after.key);

// [LAW:one-source-of-truth] The recording's forks: each place two or more of its steps stand after, with those steps,
// the siblings there, in the order they arrived. Of the whole recording, whatever step is shown, so the column's line
// where histories part and the strip's notches (view/rows.ts, view/strip.ts) say the same of it.
export function forksOf(segments: readonly Segment[]): Map<string, number[]> {
  const siblings = new Map<string, number[]>();
  segments.forEach(({ after }, index) => {
    if (after === undefined) return;
    const place = placeOf(after, segments);
    siblings.set(place, siblings.get(place) ?? []).get(place)!.push(index + 1);
  });
  return new Map([...siblings].filter(([, steps]) => steps.length > 1));
}

// The conversation's history: each step's segment, step k's at k - 1, the step of an exchange, by its trace_id, and the
// recording's forks (forksOf), derived once per history for the column and the strip alike.
// [LAW:parse-dont-validate] exception: `stepOf` takes any string, since a view's moment names its trace as stored, and
// the stored view is not parsed as it is loaded yet (dump-design-ajl.6nq); until then a trace it does not hold is a
// miss, which the conversation shows as its latest step while the read can still bring it, and replaces with now
// once nothing can (Conversation.tsx).
export type History = { segments: readonly Segment[]; stepOf: (trace: string) => number | undefined; forks: ReadonlyMap<string, number[]> };

// A thread: its level, the first message every request of it sends, what that message says, and the tree of the paths
// its requests have sent.
type Thread = { level: Level; first: KeyedBlock[]; said: string; root: Root };
// The root of a thread's tree, before any block, which the request that began the thread owns; a node, a block at its
// place, `at`, as the request that first sent it there, `owner`, sent it. Each has the nodes after it on the paths that
// pass it, and the steps whose path, reply included, ends at it.
type Root = { owner: number; children: Node[]; ends: number[] };
type Node = Root & { at: string; held: Held };
// A chain: a step, the first step that follows it, and so on, the last of them `last`, with where the items of the
// places they brought are; and, for one begun by a later sibling, the chain of the step it follows, whose places it
// resends as they were at that step.
type Chain = { places: Map<string, Location>; base: { chain: Chain; from: number } | undefined; last: number };
type Location = { step: number; group: number; index: number };

// A step read: its exchange, its thread, where it leaves the requests before it, and what undoes what reading it did to
// the threads. A step folded: its segment as it now stands, its chain, and what undoes what folding it did, in the
// order it did it.
type Read = { formatted: FormattedExchange; thread: Thread | undefined; fact: Fact | undefined; undo: (() => void)[] };
type Folded = { segment: Segment; chain: Chain | undefined; undo: (() => void)[] };

// The history of the exchanges. [LAW:no-shared-mutable-globals] Its state is its own, and what it returns is never
// changed after: an item a later step gives a version is a new item, in a new segment, and whatever it says again, a
// step folded again or not, is the object it returned before (keptSegment). The formatter returns an unchanged exchange
// as the same object, and what a step follows is decided by the steps before it (view/lines.ts), so the history is read
// and folded again only from the first exchange that is not the one read before, which, while an exchange streams, is
// the last. The steps after are undone, then read and folded again.
export function createHistory(): (formatted: FormattedExchange[]) => History {
  const alike = createComparison();
  const threads: Thread[] = [];
  const read: Read[] = [];
  const folded: Folded[] = [];
  // What a thread can hang on, in the order it arrived: each summary a reply's text ends with, by its level.
  const summaries: { level: string; step: number; key: string; summary: string }[] = [];
  // Each client tool's call, by its level and its id, in the order its items arrived, with what it launches: a call
  // that two sibling histories each send is two items with one id.
  const calls = new Map<string, { step: number; key: string; launches: Launch | undefined }[]>();
  // The levels that have a step, by their keys.
  const begun = new Set<string>();
  let last: History = { segments: [], stepOf: () => undefined, forks: new Map() };

  const itemAt = ({ step, group, index }: Location) => folded[step - 1]!.segment.groups[group]!.items[index]!;
  const replace = ({ step, group, index }: Location, item: Item) => {
    const own = folded[step - 1]!;
    own.segment = { ...own.segment, groups: own.segment.groups.with(group, { ...own.segment.groups[group]!, items: own.segment.groups[group]!.items.with(index, item) }) };
  };

  // Reading a step walks its path down its thread's tree as far as an earlier request sent the same, which is where it
  // leaves them, and adds the rest of its path, as its own.
  const readStep = (formatted: FormattedExchange, step: number): Read => {
    const undo: (() => void)[] = [];
    const thread = threadOf(formatted, levelOf(formatted.sender), threads, alike, step, undo);
    if (thread === undefined) return { formatted, thread, fact: undefined, undo };
    const begun = thread.root.owner === step;
    let node: Root = thread.root;
    const path = pathOf(formatted);
    let index = 0;
    for (; index < path.length; index++) {
      const { at, held } = path[index]!;
      const next = node.children.find((child) => child.at === at && alike(child.held, held.block));
      if (next === undefined) break;
      node = next;
    }
    const message = path[index]?.message ?? formatted.messages;
    const left = begun ? undefined : node.ends.length > 0 ? { step: node.ends.at(-1)!, whole: true, message } : { step: node.owner, whole: false, message };
    for (const { at, held } of path.slice(index)) {
      const added: Node = { at, held, owner: step, children: [], ends: [] };
      const parent = node;
      parent.children.push(added);
      undo.push(() => parent.children.pop());
      node = added;
    }
    const end = node;
    end.ends.push(step);
    undo.push(() => end.ends.pop());
    return { formatted, thread, fact: { step, left, messages: formatted.messages }, undo };
  };

  // The chain of a step that follows `followed`: that step's, while it is its last, or one begun on it.
  const chainOf = (followed: number | undefined, step: number, undo: (() => void)[]): Chain => {
    const base = followed === undefined ? undefined : { chain: folded[followed - 1]!.chain!, from: followed };
    if (base === undefined || base.chain.last !== followed) return { places: new Map(), base, last: step };
    base.chain.last = step;
    undo.push(() => (base.chain.last = followed));
    return base.chain;
  };

  // What a thread's request that follows nothing hangs on: the last summary of its level that its first message holds,
  // or nothing, a root of its level.
  const hungOn = (thread: Thread): After | undefined => {
    const level = levelKey(thread.level);
    const summary = summaries.findLast((one) => one.level === level && thread.said.includes(one.summary));
    return summary === undefined ? undefined : { step: summary.step, on: "block", key: summary.key, as: "thread" };
  };

  // Folding a step lists its blocks as items against the conversation on its path, the steps it follows up to the one
  // that follows nothing: a block as its place holds on the path adds nothing; different there, it is the item's next
  // version, where the item stands; at a place the path has not held, it is a new item, in the step's own segment; and
  // a place the path holds that the step does not send is gone from it. [LAW:dataflow-not-control-flow] Every step is
  // folded the same, whatever it follows: a sibling's versions of an item are off the path, so they are not what the
  // step's blocks are compared with.
  const fold = ({ formatted, thread }: Read, follows: ReadonlyMap<number, number | undefined>, step: number): Folded => {
    const undo: (() => void)[] = [];
    const trace = formatted.exchange.trace_id;
    const level = levelOf(formatted.sender);
    const levelName = levelKey(level);
    const followed = follows.get(step);
    const after: After | undefined = followed !== undefined ? { step: followed, on: "step" } : thread === undefined ? undefined : hungOn(thread);
    const chain = thread === undefined ? undefined : chainOf(followed, step, undo);
    const path = new Set<number>();
    for (let on: number | undefined = step; on !== undefined; on = follows.get(on)) path.add(on);
    // What the step reaches: its path, and past the thread its path begins with, the path of the step whose summary that
    // thread carries on, and so on, so a call made before a compaction is found from the thread after it.
    const reach = new Set<number>();
    for (let on: number | undefined = step; on !== undefined; ) {
      let first: number = on;
      for (let at: number | undefined = on; at !== undefined; at = follows.get(at)) reach.add((first = at));
      const carried: After | undefined = first === step ? after : folded[first - 1]!.segment.after;
      on = carried?.on === "block" && !reach.has(carried.step) ? carried.step : undefined;
    }
    const ties: Tie[] = [];
    const stops: StepWire["stops"][number][] = [];
    const answers: string[] = [];
    // That `agent` was launched by the call of id `call`: the item on the step's reach that holds that call, the last
    // to arrive, where it launches something, and found: false where none does. `by` says what named it: a result
    // names an agent only as an Agent call's answer, so one of another tool's call on the reach, as a Bash that prints
    // a result, ties nothing.
    const tie = (agent: string, call: string, by: "result" | "notice") => {
      const found = calls.get(`${levelName}/${call}`)?.findLast((one) => reach.has(one.step));
      if (by === "result" && found !== undefined && found.launches?.tool !== "Agent") return;
      ties.push(found?.launches === undefined ? { agent, call, found: false } : { agent, call, found: true, key: found.key, launches: found.launches });
    };
    // [LAW:single-enforcer] What a block the step brings to its path, at the item `key`, states (format/blocks.ts): the
    // call it makes, the call it answers, the agent its result or notification names, the stop it tells, the summary
    // it ends with. Every block the step brings is read here, a new item or a new version, and no other.
    const state = (block: KeyedBlock, key: string) => {
      if (block.call !== undefined) {
        const named = `${levelName}/${block.call.id}`;
        const list = calls.get(named) ?? [];
        calls.set(named, list);
        list.push({ step, key, launches: block.call.launches });
        undo.push(() => list.pop());
      }
      if (block.result !== undefined) {
        const { answers: call, names } = block.result;
        answers.push(call);
        if (names !== undefined) tie(names, call, "result");
      }
      if (block.notice?.kind === "stop") {
        const { agent, status, call } = block.notice;
        stops.push({ agent, status });
        if (call !== undefined) tie(agent, call, "notice");
      }
      if (block.summary !== undefined) {
        summaries.push({ level: levelName, step, key, summary: block.summary });
        undo.push(() => summaries.pop());
      }
    };
    // An item's version on the path, by its index: the last a step of the path gave it.
    const current = ({ versions }: Item) => versions.findLastIndex(({ step }) => path.has(step));
    const sent = new Set<string>();
    const groups = formatted.groups.map((group, groupIndex) => {
      const items: Item[] = [];
      for (const block of group.blocks) {
        const arrived = (key: string, reply: boolean): Item => ({ key, versions: [{ step, block, reply, rewrote: undefined, previous: undefined }] });
        if (block.place === undefined || chain === undefined) {
          const key = `${trace}/${group.key}/${block.key}`;
          items.push(arrived(key, false));
          state(block, key);
          continue;
        }
        const at = `${placeName(block.place, formatted.messages)}/${block.key}`;
        const reply = block.place.in === "reply";
        sent.add(at);
        const location = find(chain, at);
        if (location === undefined) {
          const key = `${threadPrefix}${trace}/${at}`;
          chain.places.set(at, { step, group: groupIndex, index: items.length });
          undo.push(() => chain.places.delete(at));
          items.push(arrived(key, reply));
          state(block, key);
          continue;
        }
        const item = itemAt(location);
        const previous = current(item);
        if (alike(item.versions[previous]!, block)) continue;
        // Sent again as it was after a step took it away, it rewrote nothing: a reply's block resent, too.
        const before = lastSent(item.versions, previous);
        replace(location, { ...item, versions: [...item.versions, { step, block, reply, rewrote: alike(before, block) ? undefined : before.block, previous }] });
        undo.push(() => replace(location, item));
        state(block, item.key);
      }
      return { key: group.key, title: group.title, items };
    });
    // A request resends what its path holds at each place, its tools, prompt, parameters and messages, so one there it
    // did not send is gone from the step on.
    for (const { at, location } of chain === undefined ? [] : resent(chain)) {
      if (sent.has(at)) continue;
      const item = itemAt(location);
      const previous = current(item);
      const was = item.versions[previous]!.block;
      if (was === undefined) continue;
      replace(location, { ...item, versions: [...item.versions, { step, block: undefined, was, previous }] });
      undo.push(() => replace(location, item));
    }
    const reply = replyOf(formatted);
    const waits = formatted.facts.stopReason === "tool_use" ? reply.flatMap(({ call }) => (call?.waits ? [call.id] : [])) : [];
    const did = reply.at(-1);
    const names = formatted.sender.kind === "agent" ? formatted.sender.parent : undefined;
    const opens = begun.has(levelName) || level.kind === "main" ? undefined : { names, says: thread?.said };
    if (!begun.has(levelName)) {
      begun.add(levelName);
      undo.push(() => begun.delete(levelName));
    }
    return { segment: { formatted, groups, after, wire: { level, opens, ties, stops, answers, waits, did } }, chain, undo };
  };

  return (formatted) => {
    let from = 0;
    while (from < read.length && from < formatted.length && read[from]!.formatted === formatted[from]) from++;
    if (from === read.length && from === formatted.length) return last;
    const undoTo = <T extends { undo: (() => void)[] }>(steps: T[], length: number) => {
      while (steps.length > length) for (const undo of steps.pop()!.undo.toReversed()) undo();
    };
    undoTo(folded, from);
    undoTo(read, from);
    for (let index = from; index < formatted.length; index++) read.push(readStep(formatted[index]!, index + 1));
    const facts = read.flatMap(({ fact }) => (fact === undefined ? [] : [fact]));
    const follows = new Map(followsOf(facts).map((followed, index) => [facts[index]!.step, followed]));
    for (let index = from; index < read.length; index++) folded.push(fold(read[index]!, follows, index + 1));
    const steps = new Map<string, number>(read.map(({ formatted }, index) => [formatted.exchange.trace_id, index + 1]));
    const made = folded.map(({ segment }) => segment);
    const segments = keptEach(last.segments, made, keptSegment);
    // [LAW:one-source-of-truth] A step's segment is the one handed out, not another like it, so the next read compares
    // only what it folds again.
    folded.forEach((step, index) => (step.segment = segments[index]!));
    last = { segments, stepOf: (trace) => steps.get(trace), forks: forksOf(segments) };
    return last;
  };
}

// Where the item at a place a chain resends is: its own, or else the chain's it began on, one that arrived by the step
// it follows there, and so on. What that chain's later steps brought is not on its path.
function find(chain: Chain, at: string, upTo = Infinity): Location | undefined {
  const location = chain.places.get(at);
  if (location !== undefined && location.step <= upTo) return location;
  return chain.base === undefined ? undefined : find(chain.base.chain, at, Math.min(upTo, chain.base.from));
}

// Each place a chain resends, with where its item is, as `find` reads them: its own, then those of the chain it began
// on that arrived by the step it follows there, and so on.
function* resent(chain: Chain, upTo = Infinity): Generator<{ at: string; location: Location }> {
  for (const [at, location] of chain.places) if (location.step <= upTo) yield { at, location };
  if (chain.base !== undefined) yield* resent(chain.base.chain, Math.min(upTo, chain.base.from));
}

// The last version that brought a block, from the one at `index` back along what each came after.
function lastSent(versions: readonly Version[], index: number): Sent {
  const version = versions[index]!;
  return version.block === undefined ? lastSent(versions, version.previous) : version;
}

// [LAW:single-enforcer] What a history says again, it says with the objects it returned before, decided here alone,
// where it is handed out: a step folded again makes its items anew, as each event of a reply still arriving does to the
// last step and to every item that step gave a version, and a row is the one drawn before only while its fields are the
// same objects (view/Conversation.tsx). Each of these is what was made with, at each place, the part of `before` that
// says the same, and is `before` where every part is.
const keptAs = <T extends object>(before: T | undefined, made: T): T => (before !== undefined && sameFields(before, made) ? before : made);
const keptEach = <T>(before: readonly T[] | undefined, made: readonly T[], kept: (before: T | undefined, made: T) => T): readonly T[] => {
  const each = made.map((one, index) => (one === before?.[index] ? one : kept(before?.[index], one)));
  return keptAs(before, each);
};
const keptItem = (before: Item | undefined, made: Item): Item => keptAs(before, { ...made, versions: keptEach(before?.versions, made.versions, keptAs) });
const keptGroup = (before: ItemGroup | undefined, made: ItemGroup): ItemGroup => keptAs(before, { ...made, items: keptEach(before?.items, made.items, keptItem) });
const keptSegment = (before: Segment | undefined, made: Segment): Segment =>
  keptAs(before, { ...made, groups: keptEach(before?.groups, made.groups, keptGroup), after: made.after && keptAs(before?.after, made.after), wire: keptWire(before?.wire, made.wire) });
const keptWire = (before: StepWire | undefined, made: StepWire): StepWire =>
  keptAs(before, {
    ...made,
    level: keptAs(before?.level, made.level),
    opens: made.opens && keptAs(before?.opens, made.opens),
    ties: keptEach(before?.ties, made.ties, keptAs),
    stops: keptEach(before?.stops, made.stops, keptAs),
    answers: keptAs(before?.answers, made.answers),
    waits: keptAs(before?.waits, made.waits),
  });

// Whether two objects say the same: the same fields, each the same value. A field that holds undefined is a field, so
// it does not stand for one the other does not have.
export function sameFields(a: object, b: object): boolean {
  const fields = Object.entries(a);
  return fields.length === Object.keys(b).length && fields.every(([name, value]) => Object.hasOwn(b, name) && (b as Record<string, unknown>)[name] === value);
}

// A request's path through its thread: the blocks of each message a speaker sent, then of its reply, each at its place
// and with the message it is in, the reply's index for the reply's. What a client sends around them is not on it, since
// it changes them on any request and a request of the thread can send its own: its parameters, its tools, its system
// prompt and the system's messages.
function pathOf(formatted: FormattedExchange): { at: string; message: number; held: Extract<Held, { reply: boolean }> }[] {
  return formatted.groups.flatMap(({ blocks }) =>
    blocks.flatMap((block) => {
      const message = block.place?.in === "message" ? block.place.index : block.place?.in === "reply" ? formatted.messages : undefined;
      return message === undefined ? [] : [{ at: `message.${message}/${block.key}`, message, held: { block, reply: block.place!.in === "reply" } }];
    }),
  );
}

// [LAW:one-source-of-truth] An exchange's blocks of its first message, which its thread is known by, and of its reply.
export const firstMessageOf = ({ groups }: FormattedExchange): KeyedBlock[] => groups.flatMap(({ blocks }) => blocks.filter(({ place }) => place?.in === "message" && place.index === 0));
export const replyOf = ({ groups }: FormattedExchange): KeyedBlock[] => groups.flatMap(({ blocks }) => blocks.filter(({ place }) => place?.in === "reply"));

// The thread of its level an exchange is part of: the one whose first message it sends, or, when none was sent before, a
// new one it begins, which `undo` drops. None while its request sends no message, as while its body is not yet read.
function threadOf(formatted: FormattedExchange, level: Level, threads: Thread[], alike: Comparison, step: number, undo: (() => void)[]): Thread | undefined {
  const first = firstMessageOf(formatted);
  if (first.length === 0) return undefined;
  const key = levelKey(level);
  const found = threads.find((thread) => levelKey(thread.level) === key && thread.first.length === first.length && thread.first.every((block, index) => alike.blocks(block, first[index]!)));
  if (found !== undefined) return found;
  const begun: Thread = { level, first, said: saidIn(first), root: { owner: step, children: [], ends: [] } };
  threads.push(begun);
  undo.push(() => threads.pop());
  return begun;
}

// What a message says: the texts of its blocks that the harness did not inject, less the space around them.
export function saidIn(blocks: KeyedBlock[]): string {
  const texts = blocks.flatMap(({ injected, parts }) => (injected === undefined ? parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])) : []));
  return texts.join("").trim();
}

// A place's name in its thread: the request's own for its parameters, its tools, its system prompt; a speaker's
// message, the reply the one after the request's; or a message no speaker sent, by the speaker's it stands before.
function placeName(place: Place, messages: number): string {
  switch (place.in) {
    case "parameters":
      return "request";
    case "tools":
    case "system":
      return place.in;
    case "message":
      return `message.${place.index}`;
    case "between":
      return `message.${place.before}.system.${place.index}`;
    case "reply":
      return `message.${messages}`;
  }
}

// Whether a block is an item's version, and whether two blocks are alike. [LAW:no-shared-mutable-globals] Its cache is
// its own: each pair's answer, kept under the blocks, which the formatter keeps the same objects while their side of the
// exchange is unchanged, so folding again from a streaming exchange compares only its blocks, and each once.
type Comparison = ((held: Held, block: KeyedBlock) => boolean) & { blocks: (a: KeyedBlock, b: KeyedBlock) => boolean };
// What a place holds: a block, and whether it arrived as a reply, or none.
type Held = { block: KeyedBlock; reply: boolean } | { block: undefined };
function createComparison(): Comparison {
  const answers = new WeakMap<Block, WeakMap<Block, boolean>>();
  const cached = (a: Block, b: Block, answer: () => boolean) => {
    const own = answers.get(a) ?? new WeakMap<Block, boolean>();
    answers.set(a, own);
    const known = own.get(b) ?? answer();
    own.set(b, known);
    return known;
  };
  const blocks = (a: KeyedBlock, b: KeyedBlock) => cached(a, b, () => equal(content(a), content(b)));
  // A reply is compared as it is resent: a request resends a reply's content block, and only the client knows which of
  // the fields the API reported about it (a thinking block's estimated_tokens, a tool use's caller) it keeps, so of the
  // fields no read asked for, only those the resent block has.
  const compare = (held: Held, block: KeyedBlock) =>
    held.block === undefined
      ? false
      : held.reply && block.place?.in !== "reply"
        ? cached(held.block, block, () => equal(content(asResent(held.block, block)), content(block)))
        : blocks(held.block, block);
  return Object.assign(compare, { blocks });
}

// What a block shows, without its key and place, which name where it is: what two blocks are alike by, and what the
// diff of a rewrite reads (view/change.ts).
function content({ category, name, parts, injected }: Block): unknown {
  return { category, name, parts, injected };
}

// A reply's block with, of each part of its fields no read asked for, only the fields the part of that id in `resent`
// has.
function asResent(reply: Block, resent: Block): Block {
  const kept = new Map(resent.parts.flatMap((part) => (part.kind === "rest" ? [[part.id, new Set(part.fields.map(([name]) => name))] as const] : [])));
  return {
    ...reply,
    parts: reply.parts.flatMap((part): Part[] => {
      if (part.kind !== "rest") return [part];
      const fields = part.fields.filter(([name]) => kept.get(part.id)?.has(name) === true);
      return fields.length === 0 ? [] : [{ ...part, fields }];
    }),
  };
}
