import type { Exchange } from "../exchanges.ts";
import type { Part } from "../format/blocks.ts";
import type { FormattedExchange, Group, KeyedBlock } from "../format/format.ts";

// The conversation as the rows the view lists, one line or one block each, so only the rows on screen are mounted:
// each request resends the whole history, so a long recording holds blocks by the hundred thousand.
// [LAW:types-are-the-program] A row's key names what it shows, `<trace_id>`, then `/<group key>`, then
// `/<block key>`, so it is the same row however many rows arrive around it.
export type Row =
  | { kind: "exchange"; key: string; exchange: Exchange }
  | { kind: "group"; key: string; title: Group["title"] }
  | { kind: "block"; key: string; block: KeyedBlock; size: number };

// The rows of a conversation, and their keys.
export type Layout = { rows: Row[]; keys: Keys };

// The rows' keys in order: the key at an index, and the index of a key. [LAW:types-are-the-program] The same object
// while no row arrives, goes or moves, however what a row shows changes, so what places rows by key (the virtualizer,
// from the first row, at 5 ms a time over a long recording) places them again only when one did.
export type Keys = { at: (index: number) => string; indexOf: (key: string) => number | undefined };

// One exchange's rows, their keys, and each key's index among them.
type ExchangeRows = { trace: string; rows: Row[]; keys: string[]; index: Map<string, number> };

// Lays out exchanges as rows. [LAW:no-shared-mutable-globals] Its caches are its own: the formatter returns an unchanged
// exchange, and an unchanged group of a changed one (a request's, while its response streams), as the same object, so
// their rows are the ones laid out before: a frame lays out and sizes only what changed, and only those rows render.
export function createLayout(): (formatted: FormattedExchange[]) => Layout {
  const laidOut = new WeakMap<FormattedExchange, ExchangeRows>();
  const groups = new WeakMap<Group, Row[]>();
  const groupRows = (trace: string, group: Group) => {
    const rows = groups.get(group) ?? rowsOf(trace, group);
    groups.set(group, rows);
    return rows;
  };
  let last: { exchanges: ExchangeRows[]; keys: Keys } = { exchanges: [], keys: keysOf([]) };
  return (formatted) => {
    const before = new Map(last.exchanges.map((own) => [own.trace, own]));
    const exchanges = formatted.map((exchange) => {
      const own = laidOut.get(exchange) ?? exchangeRows(exchange, groupRows, before.get(exchange.exchange.trace_id));
      laidOut.set(exchange, own);
      return own;
    });
    const same = exchanges.length === last.exchanges.length && exchanges.every((own, index) => own.keys === last.exchanges[index]!.keys);
    last = { exchanges, keys: same ? last.keys : keysOf(exchanges) };
    const rows: Row[] = [];
    for (const own of exchanges) for (const row of own.rows) rows.push(row);
    return { rows, keys: last.keys };
  };
}

// An exchange's rows. `before`: the exchange's rows laid out last, whose keys it keeps, the same array, when its rows'
// keys are the same.
function exchangeRows({ exchange, groups }: FormattedExchange, groupRows: (trace: string, group: Group) => Row[], before: ExchangeRows | undefined): ExchangeRows {
  const trace = exchange.trace_id;
  const rows: Row[] = [{ kind: "exchange", key: trace, exchange }, ...groups.flatMap((group) => groupRows(trace, group))];
  const keys = rows.map(({ key }) => key);
  if (before !== undefined && before.keys.length === keys.length && before.keys.every((key, index) => key === keys[index])) return { ...before, rows };
  return { trace, rows, keys, index: new Map(keys.map((key, index) => [key, index])) };
}

function keysOf(exchanges: ExchangeRows[]): Keys {
  const keys: string[] = [];
  const starts = new Map<string, { start: number; index: Map<string, number> }>();
  for (const { trace, keys: own, index } of exchanges) {
    starts.set(trace, { start: keys.length, index });
    for (const key of own) keys.push(key);
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

// A group's rows: its title, then its blocks. A group is one exchange's, so `trace` is the same for every call with it.
function rowsOf(trace: string, group: Group): Row[] {
  const key = `${trace}/${group.key}`;
  return [{ kind: "group", key, title: group.title }, ...group.blocks.map((block): Row => ({ kind: "block", key: `${key}/${block.key}`, block, size: sizeOf(block.parts) }))];
}

// How much a block holds, in characters of its content: what its collapsed line says, and what its expanded height is
// estimated from. A JSON string is counted by its length, so a tool's input still streaming is not serialized each time.
function sizeOf(parts: Part[]): number {
  return parts.reduce((size, part) => {
    switch (part.kind) {
      case "text":
        return size + part.text.length;
      case "json":
        return size + (typeof part.value === "string" ? part.value.length : (JSON.stringify(part.value, null, 2)?.length ?? 0));
      case "fields":
        return size + part.fields.reduce((length, [name, value]) => length + name.length + value.length, 0);
      case "media":
        return size + (part.source.type === "base64" ? part.source.data.length : part.source.type === "url" ? part.source.url.length : part.source.file_id.length);
    }
  }, 0);
}

// A size in characters, to one decimal of the largest unit it reaches once rounded, so 999,960 reads 1.0M, not 1000.0k.
export function describeSize(size: number): string {
  if (size < 1000) return `${size} chars`;
  const thousands = (size / 1000).toFixed(1);
  return Number(thousands) < 1000 ? `${thousands}k chars` : `${(size / 1_000_000).toFixed(1)}M chars`;
}

// Whether a row shows expanded: a block the reader toggled as they left it, and otherwise as its category starts, the
// user's and the assistant's expanded, the rest collapsed (docs/design/01-mvp.md, F4). Rows of other kinds are a line.
export function isExpanded(toggled: Record<string, boolean>, row: Row): boolean {
  return row.kind === "block" && (toggled[row.key] ?? (row.block.category === "user" || row.block.category === "assistant"));
}

// A row's height before it is measured, in pixels: one line, or a block's content at about 100 characters a line.
// Only rows not yet on screen use it, so it decides how the scrollbar reads, not where anything lands.
export function estimateHeight(row: Row, expanded: boolean): number {
  const line = 20;
  return row.kind === "block" && expanded ? line + Math.ceil(row.size / 100) * 16 : line;
}
