import type { Block, Category, Part } from "../format/blocks.ts";
import type { FormattedExchange, Group, KeyedBlock } from "../format/format.ts";
import type { Visibility } from "../settings.ts";

// The conversation as the rows the view lists, one line or one block each, so only the rows on screen are mounted:
// each request resends the whole history, so a long recording holds blocks by the hundred thousand.
// [LAW:types-are-the-program] A row's key names what it shows, `<trace_id>`, then `/<group key>`, then
// `/<block key>`, so it is the same row however many rows arrive around it.
export type Row =
  | { kind: "exchange"; key: string; exchange: FormattedExchange }
  | { kind: "group"; key: string; title: Group["title"] }
  | { kind: "block"; key: string; block: KeyedBlock; size: number };

// The rows of a conversation, and their keys: those listed, which are every row but the blocks of a hidden category, the
// group titles over none left, and the block revealed; and `every` row, listed or not, which the search reads, since a
// hidden category's blocks are searched (docs/design/01-mvp.md, F6).
export type Layout = { rows: Row[]; keys: Keys; every: { rows: Row[]; keys: Keys } };

// The rows' keys in order: the key at an index, and the index of a key: of its row, or, for a row not listed, of the row
// listed before it, whose end is where it stands. [LAW:types-are-the-program] The same object while no row, listed or
// not, arrives, goes or moves, however what a row shows changes, so what places rows by key (the virtualizer, from the
// first row, at 5 ms a time over a long recording) places them again only when one did.
export type Keys = { at: (index: number) => string; indexOf: (key: string) => number | undefined };

// The keys of a list of rows, in order, and each key's index among them; among the rows listed, a row not listed is at
// the row listed before it, whose end is where it stands.
type Places = { keys: string[]; index: Map<string, number> };

// One exchange's rows listed and the places of their keys, every row of it and the places of theirs, and `revealed`, the
// key of the hidden block they were laid out with listed, when it is in this exchange. `formatted`: the exchange they
// are of, which alone decides every row of it.
type ExchangeRows = { trace: string; formatted: FormattedExchange; rows: Row[]; listed: Places; every: Row[]; all: Places; revealed: string | undefined };

// A group's rows, its title and every block, each sized, whichever categories are hidden.
type GroupRows = { title: Extract<Row, { kind: "group" }>; blocks: Extract<Row, { kind: "block" }>[] };

// Lays out groups as rows. [LAW:no-shared-mutable-globals] Its cache is its own: the formatter returns an unchanged
// group as the same object, so its rows are the ones laid out before, and every layout lists the same group and block
// rows whichever categories it hides: a category shown or hidden sizes no block again, and a block still listed does
// not render again.
export function createGroupRows(): (trace: string, group: Group) => GroupRows {
  const laidOut = new WeakMap<Group, GroupRows>();
  return (trace, group) => {
    const rows = laidOut.get(group) ?? rowsOf(trace, group);
    laidOut.set(group, rows);
    return rows;
  };
}

// Lays out exchanges as rows, leaving out the blocks of each category `visibility` hides (docs/design/01-mvp.md, F5),
// but the one at the key `revealed`, which the search has stepped to (F6), and a group with no block left, rather than a
// title over nothing. [LAW:no-shared-mutable-globals] Its cache is its own: the formatter returns an unchanged exchange
// as the same object, so its rows are the ones laid out before: a frame lays out only what changed, and only those rows
// render. It holds for one visibility, so another is another layout; a change of `revealed` lays out again only the
// exchange it leaves and the one it enters.
export function createLayout(
  visibility: Record<Category, Visibility>,
  groupRows: (trace: string, group: Group) => GroupRows,
): (formatted: FormattedExchange[], revealed: string | undefined) => Layout {
  const laidOut = new WeakMap<FormattedExchange, ExchangeRows>();
  const groupLayout = (trace: string, group: Group, revealed: string | undefined) => {
    const { title, blocks } = groupRows(trace, group);
    const shown = blocks.filter(({ key, block }) => isListed[visibility[block.category]] || key === revealed);
    return { listed: shown.length === 0 ? [] : [title, ...shown], every: [title, ...blocks] };
  };
  // The layout returned last, and the exchanges' rows it was laid out from: a layout whose exchanges' rows are all the
  // ones before is the layout before, as when only traffic the view does not show arrived.
  let last: { exchanges: ExchangeRows[]; layout: Layout } = {
    exchanges: [],
    layout: { rows: [], keys: keysOf([], (own) => own.listed), every: { rows: [], keys: keysOf([], (own) => own.all) } },
  };  return (formatted, revealed) => {
    const before = new Map(last.exchanges.map((own) => [own.trace, own]));
    const exchanges = formatted.map((exchange) => {
      const trace = exchange.exchange.trace_id;
      const here = revealed?.startsWith(`${trace}/`) ? revealed : undefined;
      const cached = laidOut.get(exchange);
      const own = cached !== undefined && cached.revealed === here ? cached : exchangeRows(exchange, groupLayout, here, before.get(trace));
      laidOut.set(exchange, own);
      return own;
    });
    const sameAs = (pick: (own: ExchangeRows) => unknown) =>
      exchanges.length === last.exchanges.length && exchanges.every((own, index) => pick(own) === pick(last.exchanges[index]!));
    if (sameAs((own) => own.rows)) return last.layout;
    last = {
      exchanges,
      layout: {
        rows: concat(exchanges, (own) => own.rows),
        keys: sameAs((own) => own.listed) ? last.layout.keys : keysOf(exchanges, (own) => own.listed),
        // [LAW:one-source-of-truth] Every row depends on the exchanges alone, never on `revealed`, so the same exchanges
        // are the same `every`, and what memoizes on it (the search) is not run again by a step of the search.
        every: sameAs((own) => own.formatted)
          ? last.layout.every
          : {
              rows: concat(exchanges, (own) => own.every),
              keys: sameAs((own) => own.all) ? last.layout.every.keys : keysOf(exchanges, (own) => own.all),
            },
      },
    };
    return last.layout;
  };
}

// The rows `pick` gives for each exchange, one list in order.
function concat(exchanges: ExchangeRows[], pick: (own: ExchangeRows) => Row[]): Row[] {
  const rows: Row[] = [];
  for (const own of exchanges) for (const row of pick(own)) rows.push(row);
  return rows;
}

// An exchange's rows: of each group, those `groupLayout` lists, and every one. `revealed`: the hidden block to list, if
// it is in this exchange. `before`: the exchange's rows laid out last, whose places it keeps, the same objects, while the
// keys they are of are the same.
function exchangeRows(
  formatted: FormattedExchange,
  groupLayout: (trace: string, group: Group, revealed: string | undefined) => { listed: Row[]; every: Row[] },
  revealed: string | undefined,
  before: ExchangeRows | undefined,
): ExchangeRows {
  const trace = formatted.exchange.trace_id;
  const laidOut = formatted.groups.map((group) => groupLayout(trace, group, revealed));
  const line: Row = { kind: "exchange", key: trace, exchange: formatted };
  const rows = [line, ...laidOut.flatMap(({ listed }) => listed)];
  const every = [line, ...laidOut.flatMap(({ every }) => every)];
  const keys = rows.map(({ key }) => key);
  const all = every.map(({ key }) => key);
  // Each list of places is the one before while its keys are the same: revealing a block changes what is listed, not what
  // is.
  const listed = before !== undefined && same(before.listed.keys, keys) ? before.listed : listedPlaces(keys, all);
  const places = before !== undefined && same(before.all.keys, all) ? before.all : { keys: all, index: new Map(all.map((key, at) => [key, at])) };
  return { trace, formatted, rows, listed, every, all: places, revealed };
}

// The places of the keys listed, `keys`, among those of every row, `all`. A row not listed is at the row listed before
// it, the exchange's own line at the latest, whose end is where it stands: a reader whose row a category hid is shown
// what now stands there, not the group or exchange it was inside.
function listedPlaces(keys: string[], all: string[]): Places {
  const index = new Map(keys.map((key, at) => [key, at]));
  let listedBefore = 0;
  for (const key of all) {
    const own = index.get(key);
    if (own === undefined) index.set(key, listedBefore);
    else listedBefore = own;
  }
  return { keys, index };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((key, at) => key === b[at]);

// The keys of the rows `places` gives for each exchange, in order.
function keysOf(exchanges: ExchangeRows[], places: (own: ExchangeRows) => Places): Keys {
  const keys: string[] = [];
  const starts = new Map<string, { start: number; index: Map<string, number> }>();
  for (const own of exchanges) {
    const { keys: ownKeys, index } = places(own);
    starts.set(own.trace, { start: keys.length, index });
    for (const key of ownKeys) keys.push(key);
  }
  return {
    at: (index) => keys[index]!,
    indexOf: (key) => {
      const trace = starts.get(key.split("/", 1)[0]!);
      const local = trace?.index.get(key);
      return local === undefined ? undefined : trace!.start + local;
    },
  };
}

// [LAW:types-are-the-program] Whether a block of each visibility is listed: the compiler asks for an entry for each.
const isListed: Record<Visibility, boolean> = { shown: true, hidden: false };

// A group is one exchange's, so `trace` is the same for every call with it.
function rowsOf(trace: string, group: Group): GroupRows {
  const key = `${trace}/${group.key}`;
  return {
    title: { kind: "group", key, title: group.title },
    blocks: group.blocks.map((block) => ({ kind: "block", key: `${key}/${block.key}`, block, size: sizeOf(block.parts) })),
  };
}

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
function sizeOf(parts: Part[]): number {
  return parts.reduce((size, part) => {
    switch (part.kind) {
      case "text":
        return size + part.text.length;
      case "json":
        return size + (typeof part.value === "string" ? part.value.length : jsonText(part).length);
      case "fields":
        return size + part.fields.reduce((length, [name, value]) => length + name.length + value.length, 0);
      case "media":
        return size + (part.source.type === "base64" ? part.source.data.length : part.source.type === "url" ? part.source.url.length : part.source.file_id.length);
    }
  }, 0);
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

// Whether a row shows expanded: a block as its category starts, the user's and the assistant's expanded and the rest
// collapsed, and what the harness injected into their messages collapsed with the rest, since it is not what they said
// (docs/design/01-mvp.md, F4), unless the reader flipped it. Rows of other kinds are a line.
export function isExpanded(flipped: Record<string, true>, row: Row): boolean {
  return row.kind === "block" && (flipped[row.key] === true) !== startsExpanded(row.block);
}
const startsExpanded = ({ category, injected }: Block): boolean => injected === undefined && (category === "user" || category === "assistant");

// A row's height before it is measured, in pixels: one line, an exchange's band with the space above it, or a block's
// content at about 100 characters a line. Only rows not yet on screen use it, so it decides how the scrollbar reads, not
// where anything lands.
export function estimateHeight(row: Row, expanded: boolean): number {
  const line = 20;
  if (row.kind === "exchange") return 36;
  return row.kind === "block" && expanded ? line + Math.ceil(row.size / 100) * 16 : line;
}
