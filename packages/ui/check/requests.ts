import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { exchanges } from "../src/exchanges.ts";
import { createDecoding } from "../src/format/body.ts";

// Each request of a recording as one JSON line, `{ trace, headers, body }`, its body decoded and parsed, so a wire fact
// is counted with jq: `node packages/ui/check/requests.ts <recording.jsonl> | jq …` (docs/design/claude-code-wire.md).
// The recording is read as a stream and each exchange printed, and dropped, once its request is whole.
// [LAW:no-silent-failure] A body that is not whole JSON stops the read with the trace that holds it.

const recording = process.argv[2];
if (recording === undefined) throw new Error("Give the recording: node packages/ui/check/requests.ts <recording.jsonl>");
const pending = new Map<string, RecordedEvent[]>();
const printed = new Set<string>();
for await (const line of createInterface({ input: createReadStream(recording) })) {
  if (line === "") continue;
  const event = JSON.parse(line) as RecordedEvent;
  if (printed.has(event.trace_id)) continue;
  const events = pending.get(event.trace_id) ?? [];
  events.push(event);
  pending.set(event.trace_id, events);
  const [exchange] = exchanges(events);
  if (exchange === undefined || exchange.request.completedBy === undefined) continue;
  pending.delete(event.trace_id);
  printed.add(event.trace_id);
  const headers = exchange.request.head?.headers ?? [];
  const decoded = createDecoding(headers).decode(exchange.request.body, true);
  if (decoded.error !== undefined) throw new Error(`${exchange.trace_id}: body not decoded: ${decoded.error}`);
  // A request with no body, as a GET's, is printed with a body of null.
  const body: unknown = decoded.text === "" ? null : JSON.parse(decoded.text);
  console.log(JSON.stringify({ trace: exchange.trace_id, headers, body }));
}
