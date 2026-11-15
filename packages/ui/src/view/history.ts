import { unreadLabel, type Block, type Part } from "../format/blocks.ts";
import type { FormattedExchange, Group, KeyedBlock, Place } from "../format/format.ts";

// The conversation through time (docs/design/02-design.md, "Two axes"). A step is an exchange, in the order exchanges
// began, a turn, a quota probe, a title request and a subagent's request alike, and the conversation at step k is what
// exchanges 1..k brought to it. Each request resends its thread's history, so an item of the conversation is not a
// request's block but a block at its place in a thread: it enters with the exchange it first arrives with and stays
// there, resending it adds nothing, and different content at its place is a new version of it.

// A version of an item: the block at its place from `step` on, and whether it arrived as a reply, which is compared with
// the block the next request resends as that block is.
export type Version = { step: number; block: KeyedBlock; reply: boolean };

// An item: its key, and each version it has had, in the order of their steps, the first the one it arrived with.
// [LAW:types-are-the-program] The key names the place, so it is the same at every moment: a thread's place is
// `thread:<trace>/request/<block>` or `thread:<trace>/message.<i>/<block>`, named apart from any exchange's rows, since a
// key's `/` prefixes are the rows it stands inside (position.ts) and a thread's place stands inside none of the rows of
// the exchange that began it. What is an exchange's own is keyed as its row always was, `<trace>/<group>/<block>`.
export type Item = { key: string; versions: readonly Version[] };

// A step's part of the conversation: its exchange, and each of its groups with the items that first arrived in it.
export type Segment = { formatted: FormattedExchange; groups: { key: string; title: Group["title"]; items: Item[] }[] };

// The conversation's history: each step's segment, step k's at k - 1, and the step of an exchange, by its trace_id.
export type History = { segments: Segment[]; stepOf: (trace: string) => number | undefined };

// A thread: the trace_id of the exchange that began it, the first message every request of it sends, and where each of
// its places' items is, by its place.
type Thread = { trace: string; first: KeyedBlock[]; places: Map<string, Location> };
type Location = { step: number; group: number; index: number };

// A step folded: its exchange, its segment as it now stands, and what undoes what folding it did, in the order it did it.
type Folded = { formatted: FormattedExchange; segment: Segment; undo: (() => void)[] };

// The history of the exchanges. [LAW:no-shared-mutable-globals] Its state is its own, and what it returns is never
// changed after: an item a later step gives a version is a new item, in a new segment. The formatter returns an
// unchanged exchange as the same object, so the history is folded again only from the first exchange that is not the
// one folded before, which, while an exchange streams, is the last: the steps after it are undone, and the threads they
// began dropped, then folded again.
export function createHistory(): (formatted: FormattedExchange[]) => History {
  const alike = createComparison();
  const threads: Thread[] = [];
  const folded: Folded[] = [];
  let last: History = { segments: [], stepOf: () => undefined };

  const itemAt = ({ step, group, index }: Location) => folded[step - 1]!.segment.groups[group]!.items[index]!;
  const replace = ({ step, group, index }: Location, item: Item) => {
    const own = folded[step - 1]!;
    own.segment = { ...own.segment, groups: own.segment.groups.with(group, { ...own.segment.groups[group]!, items: own.segment.groups[group]!.items.with(index, item) }) };
  };

  const fold = (formatted: FormattedExchange, step: number): Folded => {
    const undo: (() => void)[] = [];
    const trace = formatted.exchange.trace_id;
    const thread = threadOf(formatted, threads, alike, undo);
    const groups = formatted.groups.map((group, groupIndex) => {
      const items: Item[] = [];
      for (const block of group.blocks) {
        const arrived = (key: string, reply: boolean): Item => ({ key, versions: [{ step, block, reply }] });
        if (block.place === undefined || thread === undefined) {
          items.push(arrived(`${trace}/${group.key}/${block.key}`, false));
          continue;
        }
        const at = `${placeName(block.place, formatted.messages)}/${block.key}`;
        const reply = block.place.in === "reply";
        const location = thread.places.get(at);
        if (location === undefined) {
          thread.places.set(at, { step, group: groupIndex, index: items.length });
          undo.push(() => thread.places.delete(at));
          items.push(arrived(`thread:${thread.trace}/${at}`, reply));
          continue;
        }
        // Resent, it adds nothing; different, it is the item's next version, where the item stands.
        const item = itemAt(location);
        if (alike(item.versions.at(-1)!, block)) continue;
        replace(location, { ...item, versions: [...item.versions, { step, block, reply }] });
        undo.push(() => replace(location, item));
      }
      return { key: group.key, title: group.title, items };
    });
    return { formatted, segment: { formatted, groups }, undo };
  };

  return (formatted) => {
    let from = 0;
    while (from < folded.length && from < formatted.length && folded[from]!.formatted === formatted[from]) from++;
    if (from === folded.length && from === formatted.length) return last;
    while (folded.length > from) for (const undo of folded.pop()!.undo.toReversed()) undo();
    for (let index = from; index < formatted.length; index++) folded.push(fold(formatted[index]!, index + 1));
    const steps = new Map(folded.map(({ formatted }, index) => [formatted.exchange.trace_id, index + 1]));
    last = { segments: folded.map(({ segment }) => segment), stepOf: (trace) => steps.get(trace) };
    return last;
  };
}

// The thread an exchange is part of: the one whose first message it sends, or, when none was sent before, a new one it
// begins, which `undo` drops. None while its request sends no message, as while its body is not yet read.
function threadOf(formatted: FormattedExchange, threads: Thread[], alike: Comparison, undo: (() => void)[]): Thread | undefined {
  const first = formatted.groups.flatMap(({ blocks }) => blocks.filter(({ place }) => place?.in === "message" && place.index === 0));
  if (first.length === 0) return undefined;
  const found = threads.find((thread) => thread.first.length === first.length && thread.first.every((block, index) => alike.blocks(block, first[index]!)));
  if (found !== undefined) return found;
  const begun: Thread = { trace: formatted.exchange.trace_id, first, places: new Map() };
  threads.push(begun);
  undo.push(() => threads.pop());
  return begun;
}

// A place's name in its thread: what the request sends besides its messages, or a message, the reply the one after the
// request's.
function placeName(place: Place, messages: number): string {
  switch (place.in) {
    case "request":
      return "request";
    case "message":
      return `message.${place.index}`;
    case "reply":
      return `message.${messages}`;
  }
}

// Whether a block is an item's version, and whether two blocks are alike. [LAW:no-shared-mutable-globals] Its cache is
// its own: each pair's answer, kept under the blocks, which the formatter keeps the same objects while their side of the
// exchange is unchanged, so folding again from a streaming exchange compares only its blocks, and each once.
type Comparison = ((version: Version, block: KeyedBlock) => boolean) & { blocks: (a: KeyedBlock, b: KeyedBlock) => boolean };
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
  const compare = (version: Version, block: KeyedBlock) =>
    version.reply && block.place?.in !== "reply" ? cached(version.block, block, () => equal(content(asResent(version.block, block)), content(block))) : blocks(version.block, block);
  return Object.assign(compare, { blocks });
}

// What a block shows, without its key and place, which name where it is.
function content({ category, name, parts, injected }: Block): unknown {
  return { category, name, parts, injected };
}

// A reply's block with, of its fields no read asked for, only those `resent` has.
function asResent(reply: Block, resent: Block): Block {
  const kept = resent.parts.find(isUnread)?.value;
  const keeps = (name: string) => typeof kept === "object" && kept !== null && Object.hasOwn(kept, name);
  return {
    ...reply,
    parts: reply.parts.flatMap((part): Part[] => {
      if (!isUnread(part)) return [part];
      const fields = Object.entries(part.value as Record<string, unknown>).filter(([name]) => keeps(name));
      return fields.length === 0 ? [] : [{ ...part, value: Object.fromEntries(fields) }];
    }),
  };
}

const isUnread = (part: Part): part is Extract<Part, { kind: "json" }> => part.kind === "json" && part.label === unreadLabel;

// Whether two JSON values are the same value: an object's fields in any order, an undefined field as none.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const fields = (value: object) => Object.entries(value).filter(([, field]) => field !== undefined);
  const own = fields(a);
  const other = new Map(fields(b));
  return own.length === other.size && own.every(([name, field]) => other.has(name) && equal(field, other.get(name)));
}
