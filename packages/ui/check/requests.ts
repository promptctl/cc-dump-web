import { parseJson } from "@cc-dump/log/json";
import type { TraceId } from "@cc-dump/log/trace";
import type { RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { refusedAt } from "../src/connection/connection.ts";
import { add, type ByTrace, type Exchange, type Settled } from "../src/exchanges.ts";
import { createDecoding } from "../src/format/body.ts";
import { fileConnection } from "./recording.ts";

// Each request of a recording as one JSON line, `{ trace, headers, body }`, its body decoded and parsed, so a wire fact
// is counted with jq: `node packages/ui/check/requests.ts <recording.jsonl> | jq …` (docs/design/claude-code-wire.md).
// The recording is read as the tab reads it (src/reading.ts) and each request printed once it is whole; an exchange
// that ended is let go, so the check holds the bodies of the exchanges in flight only. `headers` is null for a request
// whose head was not recorded, so no count takes it for the main agent's.
// [LAW:no-silent-failure] A body that is not whole JSON stops the read with the trace that holds it, and the requests
// that never became whole are counted on stderr, by their traces.

const recording = process.argv[2];
if (recording === undefined) throw new Error("Give the recording: node packages/ui/check/requests.ts <recording.jsonl>");
const byTrace: ByTrace<Settled<undefined>> = new Map();
const printed = new Set<TraceId>();

function print(exchange: Exchange) {
  printed.add(exchange.trace_id);
  const head = exchange.request.head;
  const decoded = createDecoding(head?.headers ?? []).decode(exchange.request.body, true);
  if (decoded.error !== undefined) throw new Error(`${exchange.trace_id}: body not decoded: ${decoded.error}`);
  // A request with no body, as a GET's, is printed with a body of null.
  const body: unknown = decoded.text === "" ? null : parseJson(decoded.text, `${exchange.trace_id}'s body`);
  console.log(JSON.stringify({ trace: exchange.trace_id, headers: head?.headers ?? null, body }));
}

function fold(event: RecordedEvent, offset: number) {
  const exchange = add(byTrace, event);
  if (typeof exchange === "string") throw refusedAt(offset, exchange);
  if (exchange.request.completedBy !== undefined && !printed.has(exchange.trace_id)) print(exchange);
  if (exchange.end !== undefined) byTrace.set(exchange.trace_id, { state: "settled", shown: undefined });
}

const reading = new AbortController();
const done = Promise.withResolvers<RecordingEnd>();
fileConnection.read(
  recording,
  {
    event: (event, offset) => {
      try {
        fold(event, offset);
      } catch (error) {
        reading.abort();
        done.reject(error);
      }
    },
    end: done.resolve,
    failed: done.reject,
  },
  reading.signal,
);
const { unterminated_bytes } = await done.promise;
if (unterminated_bytes > 0) console.error(`${recording}: its last ${unterminated_bytes} bytes are cut off, and not read`);
const unfinished = [...byTrace.keys()].filter((trace) => !printed.has(trace));
if (unfinished.length > 0) console.error(`${unfinished.length} requests never became whole: ${unfinished.join(" ")}`);
