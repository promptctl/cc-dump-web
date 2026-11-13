import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, type Ending, type Log } from "@cc-dump/log";

export type Header = [name: string, value: string];

// What the proxy saw of one exchange, as it saw it.
export type Seen =
  | { type: "request"; method: string; url: string; http_version: string; headers: Header[] }
  | { type: "request_body"; chunk: Buffer }
  | { type: "response"; status: number; reason: string; http_version: string; headers: Header[] }
  | { type: "response_body"; chunk: Buffer }
  | ({ type: "end" } & Ending);

// [LAW:one-source-of-truth] The recording format: one JSON line per event, in the order the proxy saw
// them, joined into exchanges by the trace_id of the request's log event; overlapping exchanges interleave.
// [LAW:decomposition] It holds the wire, not an interpretation of it: headers in arrival order, case and
// repetition; body chunks as the bytes received (a gzip body stays gzip), so later parsing applies to old
// recordings too. An exchange ends with the ending its log event records.
export type RecordedEvent = { timestamp: string; trace_id: string } & (
  | Exclude<Seen, { chunk: Buffer }>
  | { type: Extract<Seen, { chunk: Buffer }>["type"]; base64: string }
);

export type Recorder = (trace_id: string, seen: Seen) => void;

// Each event is appended before the next is handled, so a proxy killed at any moment leaves every event
// it saw up to then, and no traffic leaves no file.
// [LAW:nothing-unseen] Writing is the recording's own unit of work: a write that fails is its own event,
// joined to the exchange by trace_id, and the agent's traffic never waits on the disk.
export function createRecording(log: Log, path: string): Recorder {
  mkdirSync(dirname(path), { recursive: true });
  return (trace_id, seen) => {
    const started = performance.now();
    const timestamp = new Date().toISOString();
    const event: RecordedEvent = { timestamp, trace_id, ...recorded(seen) };
    try {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    } catch (error) {
      const failed = { event: "record", trace_id, started_at: timestamp, duration_ms: performance.now() - started };
      log({ ...failed, outcome: "error", error: describe(error), path, type: seen.type });
    }
  };
}

function recorded(seen: Seen) {
  switch (seen.type) {
    case "request":
    case "response":
      return { ...seen, headers: seen.headers.filter(([name]) => !secret.has(name.toLowerCase())) };
    case "request_body":
    case "response_body":
      return { type: seen.type, base64: seen.chunk.toString("base64") };
    case "end":
      return seen;
  }
}

// [LAW:single-enforcer] Credentials are forwarded to the upstream and the agent, and never written.
const secret = new Set(["authorization", "x-api-key", "cookie", "set-cookie"]);
