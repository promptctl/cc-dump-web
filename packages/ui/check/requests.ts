import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { record, type Exchange } from "../src/exchanges.ts";
import { createDecoding } from "../src/format/body.ts";

// Each request of a recording as one JSON line, `{ trace, headers, body }`, its body decoded and parsed, so a wire fact
// is counted with jq: `node packages/ui/check/requests.ts <recording.jsonl> | jq …` (docs/design/claude-code-wire.md).
// The recording is read an event at a time, and each exchange printed, and let go, once its request is whole.
// `headers` is null for a request whose head was not recorded, so no count takes it for the main agent's.
// [LAW:no-silent-failure] A line or a body that is not whole JSON stops the read with the line or the trace that holds
// it, and the requests that never became whole are counted on stderr, by their traces.

const recording = process.argv[2];
if (recording === undefined) throw new Error("Give the recording: node packages/ui/check/requests.ts <recording.jsonl>");
const parsed = <T>(text: string, where: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${where}: not JSON: ${(error as Error).message}`, { cause: error });
  }
};
const byTrace = new Map<string, Exchange>();
const printed = new Set<string>();
let number = 0;
for await (const line of createInterface({ input: createReadStream(recording), crlfDelay: Infinity })) {
  number++;
  if (line === "") continue;
  const event = parsed<RecordedEvent>(line, `${recording}:${number}`);
  if (printed.has(event.trace_id)) continue;
  const exchange = record(byTrace, event);
  if (exchange.request.completedBy === undefined) continue;
  byTrace.delete(exchange.trace_id);
  printed.add(exchange.trace_id);
  const head = exchange.request.head;
  const decoded = createDecoding(head?.headers ?? []).decode(exchange.request.body, true);
  if (decoded.error !== undefined) throw new Error(`${exchange.trace_id}: body not decoded: ${decoded.error}`);
  // A request with no body, as a GET's, is printed with a body of null.
  const body: unknown = decoded.text === "" ? null : parsed(decoded.text, `${exchange.trace_id}: body`);
  console.log(JSON.stringify({ trace: exchange.trace_id, headers: head?.headers ?? null, body }));
}
if (byTrace.size > 0) console.error(`${byTrace.size} requests never became whole: ${[...byTrace.keys()].join(" ")}`);
