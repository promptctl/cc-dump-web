import { parseJson } from "@cc-dump/log/json";
import type { TraceId } from "@cc-dump/log/trace";
import type { ByTrace } from "../src/exchanges.ts";
import { createDecoding } from "../src/format/body.ts";
import { foldOf } from "./recording.ts";

// Each request of a recording as one JSON line, `{ trace, headers, body }`, its body decoded and parsed, so a wire fact
// is counted with jq: `node packages/ui/check/requests.ts <recording.jsonl> | jq …` (docs/design/claude-code-wire.md).
// The recording is folded an event at a time (check/recording.ts), and each request printed, and its body let go, once
// it is whole. `headers` is null for a request whose head was not recorded, so no count takes it for the main agent's.
// [LAW:no-silent-failure] A body that is not whole JSON stops the read with the trace that holds it, and the requests
// that never became whole are counted on stderr, by their traces.

const recording = process.argv[2];
if (recording === undefined) throw new Error("Give the recording: node packages/ui/check/requests.ts <recording.jsonl>");
const byTrace: ByTrace = new Map();
const printed = new Set<TraceId>();
const { unterminated, events } = foldOf(recording, byTrace);
if (unterminated > 0) console.error(`${recording}: its last ${unterminated} bytes are cut off, and not read`);
for await (const { exchange } of events) {
  if (exchange.request.completedBy === undefined || printed.has(exchange.trace_id)) continue;
  printed.add(exchange.trace_id);
  const head = exchange.request.head;
  const decoded = createDecoding(head?.headers ?? []).decode(exchange.request.body, true);
  if (decoded.error !== undefined) throw new Error(`${exchange.trace_id}: body not decoded: ${decoded.error}`);
  exchange.request.body.length = 0;
  // A request with no body, as a GET's, is printed with a body of null.
  const body: unknown = decoded.text === "" ? null : parseJson(decoded.text, `${exchange.trace_id}'s body`);
  console.log(JSON.stringify({ trace: exchange.trace_id, headers: head?.headers ?? null, body }));
}
const unfinished = [...byTrace.keys()].filter((trace) => !printed.has(trace));
if (unfinished.length > 0) console.error(`${unfinished.length} requests never became whole: ${unfinished.join(" ")}`);
