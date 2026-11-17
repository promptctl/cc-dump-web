import { unreadLabel, type Block } from "../format/blocks.ts";
import type { Part } from "../format/parts.ts";
import type { FormattedExchange, Group, KeyedBlock, Place } from "../format/format.ts";
import { linesOf, type Fact, type Role } from "./lines.ts";

// The conversation through time (docs/design/02-design.md, "Two axes"). A step is an exchange, in the order exchanges
// began, a turn, a quota probe, a title request and a subagent's request alike, and the conversation at step k is what
// exchanges 1..k brought to it. Each request resends its thread's history, so an item of the conversation is not a
// request's block but a block at its place in a thread: it enters with the exchange it first arrives with and stays
// there, resending it adds nothing, and different content at its place is a new version of it.

// A version of an item: the block at its place from `step` on, whether it arrived as a reply, which is compared with
// the block the next request resends as that block is, and the block it `rewrote`, the one its place last held, where
// this one's content is another's: none for the item's first, and for one sent again as it was after a step took it
// away. [LAW:one-source-of-truth] So what a version did to its item is said here alone, by the comparison that made it
// a version. Or none once a request no longer sends it, `was` what its struck row shows: the block it stopped sending,
// or, of a branch's item for a place the line it left sends, that block's line alone (lineAlone).
export type Version = (Sent & { rewrote: KeyedBlock | undefined }) | Gone;
type Sent = { step: number; block: KeyedBlock; reply: boolean };
type Gone = { step: number; block: undefined; was: KeyedBlock };

// An item: its key, and each version it has had, in the order of their steps, the first the one it arrived with.
// [LAW:types-are-the-program] The key names the item, so it is the same at every moment: a thread's item is
// `thread:<trace>/tools/<block>` or `thread:<trace>/message.<i>/<block>`, by the exchange that first sent it and its
// place, never by its line, which a later request can decide again; named apart from any exchange's rows, since a key's
// `/` prefixes are the rows it stands inside (position.ts) and a thread's item stands inside none of them. What is an exchange's own is keyed as its row always was, `<trace>/<group>/<block>`.
export type Item = { key: string; versions: readonly Version[] };

// A step's part of the conversation: its exchange, each of its groups with the items that first arrived in it, and, for
// a request on a branch of its thread (view/lines.ts), the branch's key and the step it left from.
export type Segment = { formatted: FormattedExchange; groups: readonly ItemGroup[]; branch: Branch | undefined };
export type ItemGroup = { key: string; title: Group["title"]; items: readonly Item[] };
export type Branch = { key: string; from: number };

// The conversation's history: each step's segment, step k's at k - 1, the step of an exchange, by its trace_id, and the
// step of each branch's last request, by its key.
export type History = { segments: readonly Segment[]; stepOf: (trace: string) => number | undefined; branches: ReadonlyMap<string, number> };

// A thread: the first message every request of it sends, the tree of the paths its requests have sent, and its lines,
// by key, each with where its places' items are.
type Thread = { first: KeyedBlock[]; root: Root; lines: Map<string, Line> };
// The root of a thread's tree, before any block, which the request that began the thread owns; a node, a block at its
// place, `at`, as the request that first sent it there, `owner`, sent it. Each has the nodes after it on the paths that
// pass it, and the steps whose path, reply included, ends at it.
type Root = { owner: number; children: Node[]; ends: number[] };
type Node = Root & { at: string; version: Sent };
// A line's places, and the line it left, whose places it resends.
type Line = { places: Map<string, Location>; base: { line: Line; from: number } | undefined };
type Location = { step: number; group: number; index: number };

// A step read: its exchange, its thread, where it leaves the requests before it, and what undoes what reading it did to
// the threads. A step folded: its segment as it now stands, its role, and what undoes what folding it did, in the order
// it did it.
type Read = { formatted: FormattedExchange; thread: Thread | undefined; fact: Fact | undefined; undo: (() => void)[] };
type Folded = { segment: Segment; role: Role | undefined; undo: (() => void)[] };

// The history of the exchanges. [LAW:no-shared-mutable-globals] Its state is its own, and what it returns is never
// changed after: an item a later step gives a version is a new item, in a new segment, and whatever it says again, a
// step folded again or not, is the object it returned before (keptSegment). The formatter returns an unchanged exchange
// as the same object, so the history is read again only from the first exchange that is not the one read before, which,
// while an exchange streams, is the last; and folded again from there, or from the first step whose line the steps read
// again decide anew (view/lines.ts), whichever is earlier. The steps after are undone, then read and folded again.
export function createHistory(): (formatted: FormattedExchange[]) => History {
  const alike = createComparison();
  const threads: Thread[] = [];
  const read: Read[] = [];
  const folded: Folded[] = [];
  let last: History = { segments: [], stepOf: () => undefined, branches: new Map() };
  // A block's line alone: its name where it stands, in its category, with no content to open or to read. One block's is
  // one object, so a step folded again says the same of it.
  const linesAlone = new WeakMap<KeyedBlock, KeyedBlock>();
  const lineAlone = (block: KeyedBlock): KeyedBlock => {
    const line = linesAlone.get(block) ?? { ...block, parts: [], preview: [] };
    linesAlone.set(block, line);
    return line;
  };

  const itemAt = ({ step, group, index }: Location) => folded[step - 1]!.segment.groups[group]!.items[index]!;
  const replace = ({ step, group, index }: Location, item: Item) => {
    const own = folded[step - 1]!;
    own.segment = { ...own.segment, groups: own.segment.groups.with(group, { ...own.segment.groups[group]!, items: own.segment.groups[group]!.items.with(index, item) }) };
  };
  // The version that last brought a block to a place a line resends: its item's last with one, or, for a branch's item
  // that arrived gone, the one of the line it left, as `find` reads it.
  const lastSent = (line: Line, at: string, upTo = Infinity): Sent | undefined => {
    const found = find(line, at, upTo);
    if (found === undefined) return undefined;
    const sent = itemAt(found.location).versions.filter(isSent).findLast(({ step }) => step <= found.upTo);
    return sent ?? (found.line.base === undefined ? undefined : lastSent(found.line.base.line, at, Math.min(found.upTo, found.line.base.from)));
  };

  // Reading a step walks its path down its thread's tree as far as an earlier request sent the same, which is where it
  // leaves them, and adds the rest of its path, as its own.
  const readStep = (formatted: FormattedExchange, step: number): Read => {
    const undo: (() => void)[] = [];
    const thread = threadOf(formatted, threads, alike, step, undo);
    if (thread === undefined) return { formatted, thread, fact: undefined, undo };
    const begun = thread.root.owner === step;
    let node: Root = thread.root;
    const path = pathOf(formatted, step);
    let index = 0;
    for (; index < path.length; index++) {
      const { at, version } = path[index]!;
      const next = node.children.find((child) => child.at === at && alike(child.version, version.block));
      if (next === undefined) break;
      node = next;
    }
    const left = begun ? undefined : node.ends.length > 0 ? { step: node.ends.at(-1)!, whole: true } : { step: node.owner, whole: false };
    for (const { at, version } of path.slice(index)) {
      const added: Node = { at, version, owner: step, children: [], ends: [] };
      const parent = node;
      parent.children.push(added);
      undo.push(() => parent.children.pop());
      node = added;
    }
    const end = node;
    end.ends.push(step);
    undo.push(() => end.ends.pop());
    return { formatted, thread, fact: { step, trace: formatted.exchange.trace_id, left, messages: formatted.messages }, undo };
  };

  // Folding a step lists its blocks as items on its line: a block at a place the line has resent, or at one its base
  // has, adds nothing; different at a place of the line's own, it is the item's next version, where the item stands;
  // anywhere else it is a new item of the line's. [LAW:one-source-of-truth] So a branch never gives the line it left a
  // version: what it sends differently is its own.
  const fold = ({ formatted, thread }: Read, role: Role | undefined, step: number): Folded => {
    const undo: (() => void)[] = [];
    const trace = formatted.exchange.trace_id;
    const line = thread === undefined || role === undefined ? undefined : lineOf(thread, role, undo);
    const sent = new Set<string>();
    const groups = formatted.groups.map((group, groupIndex) => {
      const items: Item[] = [];
      for (const block of group.blocks) {
        const arrived = (key: string, reply: boolean): Item => ({ key, versions: [{ step, block, reply, rewrote: undefined }] });
        if (block.place === undefined || line === undefined) {
          items.push(arrived(`${trace}/${group.key}/${block.key}`, false));
          continue;
        }
        const at = `${placeName(block.place, formatted.messages)}/${block.key}`;
        const reply = block.place.in === "reply";
        sent.add(at);
        const found = find(line, at);
        if (found !== undefined && alike(itemAt(found.location).versions.findLast(({ step }) => step <= found.upTo)!, block)) continue;
        if (found?.line === line) {
          const item = itemAt(found.location);
          // Sent again as it was after a step took it away, it rewrote nothing: a reply's block resent, too.
          const before = lastSent(line, at)!;
          replace(found.location, { ...item, versions: [...item.versions, { step, block, reply, rewrote: alike(before, block) ? undefined : before.block }] });
          undo.push(() => replace(found.location, item));
          continue;
        }
        line.places.set(at, { step, group: groupIndex, index: items.length });
        undo.push(() => line.places.delete(at));
        items.push(arrived(`thread:${trace}/${at}`, reply));
      }
      return { key: group.key, title: group.title, items };
    });
    // A request resends what its line holds at each place it sends, its prompt, parameters and messages, so one there it
    // did not send is gone from the step on: an item of the line's own, its next version; one its base sent, an item of
    // the line's, gone as it arrives, which holds the block's line alone, since the block is the base's item's, where it
    // is shown and searched. A place is named for the group a request sends it in (format.ts), so the request sends a
    // place when it has that group; a message past its last is the line's after it, which it leaves as a branch.
    const groupOf = new Map(groups.map(({ key }, index) => [key, index]));
    for (const { line: holder, at, location, upTo } of line === undefined ? [] : resent(line)) {
      if (sent.has(at)) continue;
      sent.add(at);
      const item = itemAt(location);
      const was = item.versions.findLast(({ step }) => step <= upTo)!.block;
      if (was === undefined) continue;
      const group = groupOf.get(placeName(was.place!, folded[location.step - 1]!.segment.formatted.messages));
      if (group === undefined) continue;
      if (holder === line) {
        replace(location, { ...item, versions: [...item.versions, { step, block: undefined, was }] });
        undo.push(() => replace(location, item));
        continue;
      }
      line!.places.set(at, { step, group, index: groups[group]!.items.length });
      undo.push(() => line!.places.delete(at));
      groups[group]!.items.push({ key: `thread:${trace}/${at}`, versions: [{ step, block: undefined, was: lineAlone(was) }] });
    }
    const branch = role?.branch === undefined ? undefined : { key: role.line, from: role.branch.from };
    return { segment: { formatted, groups, branch }, role, undo };
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
    const roleOf = new Map(linesOf(facts).map((role, index) => [facts[index]!.step, role]));
    let refold = 0;
    while (refold < folded.length && sameRole(folded[refold]!.role, roleOf.get(refold + 1))) refold++;
    undoTo(folded, refold);
    for (let index = refold; index < read.length; index++) folded.push(fold(read[index]!, roleOf.get(index + 1), index + 1));
    const steps = new Map(read.map(({ formatted }, index) => [formatted.exchange.trace_id, index + 1]));
    const branches = new Map(folded.flatMap(({ segment: { branch } }, index) => (branch === undefined ? [] : [[branch.key, index + 1] as const])));
    const made = folded.map(({ segment }) => segment);
    const segments = keptEach(last.segments, made, keptSegment);
    // [LAW:one-source-of-truth] A step's segment is the one handed out, not another like it, so the next read compares
    // only what it folds again.
    folded.forEach((step, index) => (step.segment = segments[index]!));
    last = { segments, stepOf: (trace) => steps.get(trace), branches };
    return last;
  };
}

// A thread's line by its role: the one it has, or a new one, which `undo` drops, resending the line its branch left as
// it was at the step it left from.
function lineOf(thread: Thread, role: Role, undo: (() => void)[]): Line {
  const known = thread.lines.get(role.line);
  if (known !== undefined) return known;
  const line: Line = { places: new Map(), base: role.branch === undefined ? undefined : { line: thread.lines.get(role.branch.base)!, from: role.branch.from } };
  thread.lines.set(role.line, line);
  undo.push(() => thread.lines.delete(role.line));
  return line;
}

// Where the item at a place is, and the last step whose version of it counts: on the line, any; or else on the line it
// left, one that arrived by the step it left from, and so on. What its base sent after it left is not what it resends.
function find(line: Line, at: string, upTo = Infinity): { line: Line; location: Location; upTo: number } | undefined {
  const location = line.places.get(at);
  if (location !== undefined && location.step <= upTo) return { line, location, upTo };
  return line.base === undefined ? undefined : find(line.base.line, at, Math.min(upTo, line.base.from));
}

// Each place a line resends, with where its item is and the last step whose version of it counts, as `find` reads them:
// the line's own, then its base's that arrived by the step it left from, and so on.
function* resent(line: Line, upTo = Infinity): Generator<{ line: Line; at: string; location: Location; upTo: number }> {
  for (const [at, location] of line.places) if (location.step <= upTo) yield { line, at, location, upTo };
  if (line.base !== undefined) yield* resent(line.base.line, Math.min(upTo, line.base.from));
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
  keptAs(before, { ...made, groups: keptEach(before?.groups, made.groups, keptGroup), branch: made.branch && keptAs(before?.branch, made.branch) });

// Whether two objects say the same: every field the same value.
export function sameFields(a: object, b: object): boolean {
  const fields = Object.entries(a);
  return fields.length === Object.keys(b).length && fields.every(([name, value]) => (b as Record<string, unknown>)[name] === value);
}

const isSent = (version: Version): version is Exclude<Version, Gone> => version.block !== undefined;

const sameRole = (a: Role | undefined, b: Role | undefined) => a?.line === b?.line && a?.branch?.base === b?.branch?.base && a?.branch?.from === b?.branch?.from;

// A request's path through its thread: the blocks of its prompt, then of each message it sends, then of its reply, each
// at its place, in the order a request sends them, which is the order the cache builds its prefix in. Its parameters are
// not on it, since a client changes them on any request.
function pathOf(formatted: FormattedExchange, step: number): { at: string; version: Sent }[] {
  return formatted.groups.flatMap(({ blocks }) =>
    blocks.flatMap((block) =>
      block.place === undefined || block.place.in === "parameters"
        ? []
        : [{ at: `${placeName(block.place, formatted.messages)}/${block.key}`, version: { step, block, reply: block.place.in === "reply" } }],
    ),
  );
}

// The thread an exchange is part of: the one whose first message it sends, or, when none was sent before, a new one it
// begins, which `undo` drops. None while its request sends no message, as while its body is not yet read.
function threadOf(formatted: FormattedExchange, threads: Thread[], alike: Comparison, step: number, undo: (() => void)[]): Thread | undefined {
  const first = formatted.groups.flatMap(({ blocks }) => blocks.filter(({ place }) => place?.in === "message" && place.index === 0));
  if (first.length === 0) return undefined;
  const found = threads.find((thread) => thread.first.length === first.length && thread.first.every((block, index) => alike.blocks(block, first[index]!)));
  if (found !== undefined) return found;
  const begun: Thread = { first, root: { owner: step, children: [], ends: [] }, lines: new Map() };
  threads.push(begun);
  undo.push(() => threads.pop());
  return begun;
}

// A place's name in its thread, which is the key of the group a request sends it in (format/format.ts): the request's
// own for its parameters, its tools, its system prompt, or a message, the reply the one after the request's.
function placeName(place: Place, messages: number): string {
  switch (place.in) {
    case "parameters":
      return "request";
    case "tools":
    case "system":
      return place.in;
    case "message":
      return `message.${place.index}`;
    case "reply":
      return `message.${messages}`;
  }
}

// Whether a block is an item's version, and whether two blocks are alike. [LAW:no-shared-mutable-globals] Its cache is
// its own: each pair's answer, kept under the blocks, which the formatter keeps the same objects while their side of the
// exchange is unchanged, so folding again from a streaming exchange compares only its blocks, and each once.
type Comparison = ((version: Sent | Gone, block: KeyedBlock) => boolean) & { blocks: (a: KeyedBlock, b: KeyedBlock) => boolean };
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
  const compare = (version: Sent | Gone, block: KeyedBlock) =>
    version.block === undefined
      ? false
      : version.reply && block.place?.in !== "reply"
        ? cached(version.block, block, () => equal(content(asResent(version.block, block)), content(block)))
        : blocks(version.block, block);
  return Object.assign(compare, { blocks });
}

// What a block shows, without its key and place, which name where it is: what two blocks are alike by, and what the
// diff of a rewrite reads (view/change.ts).
function content({ category, name, parts, injected }: Block): unknown {
  return { category, name, parts, injected };
}

// A reply's block with, of its fields no read asked for, only those `resent` has.
function asResent(reply: Block, resent: Block): Block {
  const kept = new Set(resent.parts.find(isUnread)?.fields.map(([name]) => name));
  return {
    ...reply,
    parts: reply.parts.flatMap((part): Part[] => {
      if (!isUnread(part)) return [part];
      const fields = part.fields.filter(([name]) => kept.has(name));
      return fields.length === 0 ? [] : [{ ...part, fields }];
    }),
  };
}

const isUnread = (part: Part): part is Extract<Part, { kind: "fields" }> => part.kind === "fields" && part.label === unreadLabel;

// Whether two JSON values are the same value: an object's fields in any order, an undefined field as none.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const fields = (value: object) => Object.entries(value).filter(([, field]) => field !== undefined);
  const own = fields(a);
  const other = new Map(fields(b));
  return own.length === other.size && own.every(([name, field]) => other.has(name) && equal(field, other.get(name)));
}
