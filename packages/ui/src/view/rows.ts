import type { Exchange } from "../exchanges.ts";
import type { Category, Part } from "../format/blocks.ts";
import type { FormattedExchange, Group, KeyedBlock } from "../format/format.ts";

// The conversation as the rows the view lists, one line or one block each, so only the rows on screen are mounted:
// each request resends the whole history, so a long recording holds blocks by the hundred thousand.
// [LAW:types-are-the-program] A row's key names what it shows, `<trace_id>`, then `/<group key>`, then
// `/<block key>`, so it is the same row however many rows arrive around it.
export type Row =
  | { kind: "exchange"; key: string; exchange: Exchange }
  | { kind: "group"; key: string; title: Group["title"] }
  | { kind: "block"; key: string; block: KeyedBlock; size: number };

// The rows of a conversation, and where the row with a given key is among them.
export type Layout = { rows: Row[]; indexOf: (key: string) => number | undefined };

// One exchange's rows, and each one's index among them.
type ExchangeRows = { rows: Row[]; index: Map<string, number> };

// Lays out exchanges as rows. [LAW:no-shared-mutable-globals] Its cache is its own: the formatter returns an unchanged
// exchange as the same object, so its rows are the ones laid out before, and a frame lays out only what changed.
export function createLayout(): (formatted: FormattedExchange[]) => Layout {
  const laidOut = new WeakMap<FormattedExchange, ExchangeRows>();
  return (formatted) => {
    const rows: Row[] = [];
    const starts = new Map<string, { start: number; index: Map<string, number> }>();
    for (const exchange of formatted) {
      const own = laidOut.get(exchange) ?? exchangeRows(exchange);
      laidOut.set(exchange, own);
      starts.set(exchange.exchange.trace_id, { start: rows.length, index: own.index });
      for (const row of own.rows) rows.push(row);
    }
    return {
      rows,
      indexOf: (key) => {
        const trace = starts.get(key.split("/", 1)[0]!);
        const local = trace?.index.get(key);
        return local === undefined ? undefined : trace!.start + local;
      },
    };
  };
}

function exchangeRows({ exchange, groups }: FormattedExchange): ExchangeRows {
  const rows: Row[] = [{ kind: "exchange", key: exchange.trace_id, exchange }];
  for (const group of groups) {
    const key = `${exchange.trace_id}/${group.key}`;
    rows.push({ kind: "group", key, title: group.title });
    for (const block of group.blocks) rows.push({ kind: "block", key: `${key}/${block.key}`, block, size: sizeOf(block.parts) });
  }
  return { rows, index: new Map(rows.map(({ key }, index) => [key, index])) };
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

export function describeSize(size: number): string {
  if (size < 1000) return `${size} chars`;
  if (size < 1_000_000) return `${(size / 1000).toFixed(1)}k chars`;
  return `${(size / 1_000_000).toFixed(1)}M chars`;
}

// Blocks in the user and assistant categories start expanded, the rest collapsed (docs/design/01-mvp.md, F4).
export function expandedByDefault(category: Category): boolean {
  return category === "user" || category === "assistant";
}

// A row's height before it is measured, in pixels: one line, or a block's content at about 100 characters a line.
// Only rows not yet on screen use it, so it decides how the scrollbar reads, not where anything lands.
export function estimateHeight(row: Row, expanded: boolean): number {
  const line = 20;
  return row.kind === "block" && expanded ? line + Math.ceil(row.size / 100) * 16 : line;
}
