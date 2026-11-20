import type { RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { events, useEvents } from "./store.ts";

// The recording open (docs/design/features.md, F7), by its name, or none: a tab that has launched no agent and opened no
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

export type Sink = { reset: () => void; append: (batch: RecordedEvent[]) => void };

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// Where a read of `open` stands as it begins: reading it, or none.
const begun = (open: OpenRecording): Reading => (open === null ? { state: "none" } : { state: "reading", name: open });

// Reads the recording open into `sink` from its start, reporting where the read stands to `changed`, until `signal`
// aborts it. Whichever recording it is, it is the one read (docs/design/features.md, "One path to the screen"). With none
// open it reads nothing.
// [LAW:no-ambient-temporal-coupling] The read owns its batch: events arriving between frames are appended in one call
// at the next, because catching up delivers thousands in quick succession and one copy and render each would be
// quadratic. Its end and its failure append what is pending first, so no frame of the read runs after it has ended;
// its abort cancels the frame.
export function readRecording(connection: Pick<Connection, "read">, open: OpenRecording, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
  sink.reset();
  // Reported as the read begins, so an end or a failure the read reports as it begins is the last state.
  changed(begun(open));
  if (open === null) return;
  let pending: RecordedEvent[] = [];
  let cancelFrame = () => {};
  const flush = () => {
    sink.append(pending);
    pending = [];
  };
  const settle = (reading: Reading) => {
    cancelFrame();
    flush();
    changed(reading);
  };
  signal.addEventListener("abort", () => cancelFrame());
  connection.read(
    open,
    {
      event: (event) => {
        if (pending.push(event) === 1) cancelFrame = frames(flush);
      },
      end: (end) => settle({ state: "ended", name: open, end }),
      failed: (error) => settle({ state: "failed", error }),
    },
    signal,
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
// `read` is what changes on every open, so it is what a read depends on. The read empties the events with `clear`, which
// leaves `read` as it was; were it `open`, the read would change its own dependency.
export function useRecording(connection: Connection, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>(() => begun(open));
  const read = useEvents((store) => store.read);
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, open, { reset: events.clear, append: events.append }, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, open, read]);
  return reading;
}
