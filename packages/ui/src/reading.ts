import type { RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import { refusedAt, type Connection } from "./connection/connection.ts";
import { add, isEnded, release, type ByTrace, type Exchange } from "./exchanges.ts";
import { createFormatter, type FormattedExchange } from "./format/format.ts";
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

// Where a read shows what it has read: its exchanges formatted, in the order they began, each time they change.
export type Sink = (formatted: FormattedExchange[]) => void;

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
// the next, because catching up delivers thousands of events in quick succession and one format and render each would
// be quadratic. Each frame formats the read's exchanges and hands them to `sink`, and the events after it leave them as
// they are: the formatter makes anew each exchange an event changes. Then it lets go of the bodies of those that ended
// (exchanges.ts, release), so a read holds what its exchanges made, not every body its recording sends.
// [LAW:one-source-of-truth] The formatter is the read's own and lives as long as the read: once a body is let go, it
// alone holds what the body made. The read's end is its own signal, `reading`: it aborts on `signal`, and as the read
// ends, refused, ended or failed, once it has shown what is pending, by the frame's own step. Its abort cancels the
// frame, and the connection delivers nothing after it, so no frame and no event of the read comes after its end.
export function readRecording(connection: Pick<Connection, "read">, open: OpenRecording, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
  sink([]);
  // Reported as the read begins, so an end or a failure the read reports as it begins is the last state.
  changed(begun(open));
  if (open === null) return;
  const byTrace: ByTrace = new Map();
  const format = createFormatter();
  const touched = new Set<Exchange>();
  const flush = () => {
    const formatted = format([...byTrace.values()]);
    [...touched].filter(isEnded).forEach(release);
    touched.clear();
    sink(formatted);
  };
  // The one frame pending, by the function that cancels it: scheduled by the first event after a frame, none once it
  // has run.
  let frame: (() => void) | undefined;
  const shownAtFrame = () => {
    frame = undefined;
    flush();
  };
  const ended = new AbortController();
  const reading = AbortSignal.any([signal, ended.signal]);
  reading.addEventListener("abort", () => frame?.());
  const settle = (outcome: Reading) => {
    flush();
    ended.abort();
    changed(outcome);
  };
  connection.read(
    open,
    {
      event: (event, offset) => {
        const placed = add(byTrace, event);
        if (typeof placed === "string") return settle({ state: "failed", error: new Error(open, { cause: refusedAt(offset, placed) }) });
        touched.add(placed);
        frame ??= frames(shownAtFrame);
      },
      end: (end) => settle({ state: "ended", name: open, end }),
      failed: (error) => settle({ state: "failed", error }),
    },
    reading,
  );
}

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
