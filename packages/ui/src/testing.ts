import { parseTraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { add, type ByTrace, type Exchange } from "./exchanges.ts";

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
  return [...byTrace.values()];
}
