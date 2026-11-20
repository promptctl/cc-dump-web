import type { TraceId } from "@cc-dump/log/trace";
import type { RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { add, type ByTrace, type Exchange } from "./exchanges.ts";
import { recording, useExchanges } from "./store.ts";

// The recording open (docs/design/01-features.md, F7), by its name, or none: a tab that has launched no agent and opened no
// recording shows neither.
export type OpenRecording = string | null;

// [LAW:types-are-the-program] Where a read stands: none, with no recording open; reading the recording open, by its name,
// until it ends or fails. A recording the proxy run is writing ends only for a reader that leaves, and one it is not
// writing ends at its last event: so a read of an agent's recording ends when the proxy restarts, and a read begun after
// the agent's next request reaches the new proxy follows it again. A new read is begun by a mount, a reload, or opening
// a recording.
export type Reading =
  | { state: "none" }
  | { state: "reading"; name: string }
  | { state: "ended"; name: string; end: RecordingEnd }
  | { state: "failed"; error: Error };

// Where a read shows what it has read: its exchanges, in the order they began, each time they change.
export type Sink = (exchanges: Exchange[]) => void;

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// Where a read of `open` stands as it begins: reading it, or none.
const begun = (open: OpenRecording): Reading => (open === null ? { state: "none" } : { state: "reading", name: open });

// Reads the recording open into `sink` from its start, reporting where the read stands to `changed`, until `signal`
// aborts it. Whichever recording it is, it is the one read (docs/design/01-features.md, "One path to the screen"). With none
// open it reads nothing.
// [LAW:single-enforcer] The read folds each event into its exchange as it arrives (exchanges.ts, `add`), so an event
// that breaks the shape the proxy writes fails the read, naming where in the recording it ends, and ends the
// connection's read of it: what follows it cannot be trusted to be the recording.
// [LAW:no-ambient-temporal-coupling] The read owns its batch: exchanges changed between frames are shown in one call at
// the next, because catching up delivers thousands of events in quick succession and one copy and render each would be
// quadratic. Its end and its failure show what is pending first, so no frame of the read runs after it has ended; its
// abort cancels the frame. Each frame hands `sink` copies of the exchanges it changed: a frame's exchanges are not
// changed by the events after it, which the read goes on placing in its own.
export function readRecording(connection: Pick<Connection, "read">, open: OpenRecording, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
  sink([]);
  // Reported as the read begins, so an end or a failure the read reports as it begins is the last state.
  changed(begun(open));
  if (open === null) return;
  const byTrace: ByTrace = new Map();
  const shown = new Map<TraceId, Exchange>();
  const touched = new Set<TraceId>();
  let cancelFrame = () => {};
  const flush = () => {
    for (const trace of touched) shown.set(trace, snapshot(byTrace.get(trace)!));
    touched.clear();
    sink([...shown.values()]);
  };
  const settle = (reading: Reading) => {
    cancelFrame();
    flush();
    changed(reading);
  };
  const read = new AbortController();
  signal.addEventListener("abort", () => {
    cancelFrame();
    read.abort();
  });
  connection.read(
    open,
    {
      event: (event, offset) => {
        const refused = add(byTrace, event);
        if (refused !== undefined) {
          read.abort();
          return settle({ state: "failed", error: new Error(`${open}: the event ending at byte ${offset}, trace ${event.trace_id}'s ${event.type}, ${refused}`) });
        }
        if (touched.add(event.trace_id).size === 1) cancelFrame = frames(flush);
      },
      end: (end) => settle({ state: "ended", name: open, end }),
      failed: (error) => settle({ state: "failed", error }),
    },
    read.signal,
  );
}

// An exchange as it stands now, which the events after it leave as it is.
const snapshot = (exchange: Exchange): Exchange => ({
  ...exchange,
  request: { ...exchange.request, body: [...exchange.request.body] },
  response: { ...exchange.response, body: [...exchange.response.body] },
});

// The recording on screen, by its name: the one being read or read to its end. None while none is open, or the read
// failed.
export function onScreen(reading: Reading): string | undefined {
  return reading.state === "reading" || reading.state === "ended" ? reading.name : undefined;
}

const animationFrames: Frames = (callback) => {
  const frame = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(frame);
};

// The recording open, read into the store for as long as the component using it is mounted, and read again from its
// start each time one is opened.
// [LAW:one-source-of-truth] A recording is opened again by its own name, which changes nothing in `open`: the store's
// `read` is what changes on every open, so it is what a read depends on. The read empties the exchanges with `show`,
// which leaves `read` as it was; were it `open`, the read would change its own dependency.
export function useRecording(connection: Connection, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>(() => begun(open));
  const read = useExchanges((store) => store.read);
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, open, recording.show, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, open, read]);
  return reading;
}
