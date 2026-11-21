import { parseTraceId } from "@cc-dump/log/trace";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { add, type ByTrace, type Exchange } from "./exchanges.ts";

// The fields every recorded event of a test's trace carries, recorded at `timestamp`: `at(trace)` for an event of the
// trace labelled `trace`.
export const recordedAt = (timestamp: string) => (trace: string) => ({ timestamp, trace_id: parseTraceId(trace) });

// A body as the proxy records it: its JSON text, base64.
export const base64 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).toBase64();

// The events of a recorded response, its trace's, recorded at `timestamp`: a whole JSON message, which ends its turn
// and reports a token each in and out unless `message` says otherwise, and the exchange's end.
export const repliedAt =
  (timestamp: string) =>
  (trace: string, message: { content?: unknown[]; stop_reason?: string; usage?: object }): RecordedEvent[] => {
    const at = { timestamp, trace_id: parseTraceId(trace) };
    const body = { id: `msg_${trace}`, type: "message", role: "assistant", content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, ...message };
    return [
      { ...at, type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [["Content-Type", "application/json"]] },
      { ...at, type: "response_body", base64: base64(body) },
      { ...at, type: "response_trailers", headers: [] },
      { ...at, type: "end", outcome: "ok" },
    ];
  };

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
