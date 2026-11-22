import { parseTraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { add, type ByTrace, type Exchange } from "./exchanges.ts";
import { currentOf, judge, type ColumnState } from "./view/moves.ts";
import type { Keys, MomentStanding, Pending, Row } from "./view/rows.ts";
import type { Current, Standing } from "./view/search.ts";

// A moment read, in which `comes` says what can still bring a key not among its rows, and nothing brings one it says
// nothing of, the read having ended.
export const readWith = (comes: (key: string) => Pending | undefined): MomentStanding => ({
  at: "read",
  pending: (key) => {
    const read = comes(key);
    return read === undefined ? { at: "gone", why: "read_ended" } : { at: "pending", read };
  },
});

// The keys of `rows`, each at its place among them.
export const keysOf = (rows: readonly Row[]): Keys => ({
  at: (index) => rows[index]!.key,
  indexOf: (key) => {
    const index = rows.findIndex((row) => row.key === key);
    return index === -1 ? undefined : index;
  },
});

// The column of `rows`, every one listed, its moment standing as `moment` says: read, with nothing left to bring, unless
// it says otherwise.
export function columnOf(rows: Row[], moment: MomentStanding = readWith(() => undefined)): ColumnState {
  const keys = keysOf(rows);
  return { rows, keys: { ...keys, measuredBy: keys.at }, every: { rows, keys }, moment };
}

// `current` as the column's judge finds it standing under `pattern`, or an error saying how it found it instead.
export function standingIn(column: ColumnState, current: Current, pattern: RegExp): Standing {
  const judged = judge(column, current, pattern);
  const standing = currentOf(judged);
  if (standing === undefined) throw new Error(`${JSON.stringify(current)} does not stand: ${JSON.stringify(judged)}`);
  return standing;
}

// The fields every recorded event of a test's trace carries, recorded at `timestamp`: `at(trace)` for an event of the
// trace labelled `trace`.
export const recordedAt = (timestamp: string) => (trace: string) => ({ timestamp, trace_id: parseTraceId(trace) });

// The exchanges of a test's `events`, in the order they began, or an error naming the first event that breaks the shape
// by its place in the list.
export function exchanges(events: RecordedEvent[]): Exchange[] {
  const byTrace: ByTrace = new Map();
  events.forEach((event, index) => {
    const placed = add(byTrace, event);
    if (typeof placed === "string") throw new Error(`event ${index + 1}: ${placed}`);
  });
  return [...byTrace.values()].map(({ exchange }) => exchange);
}
