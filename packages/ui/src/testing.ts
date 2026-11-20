import { parseTraceId } from "@cc-dump/log/trace";

// The fields every recorded event of a test's trace carries, recorded at `timestamp`: `at(trace)` for an event of the
// trace labelled `trace`.
export const recordedAt = (timestamp: string) => (trace: string) => ({ timestamp, trace_id: parseTraceId(trace) });
