import type { Listing, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { events } from "./store.ts";
import { isOpen, type OpenRecording } from "./view/state.ts";

// [LAW:types-are-the-program] Where a read stands. The live recording ends only once the proxy that wrote it has
// stopped: the browser reconnects to it, finished now, and reads its end. A new run is a new read, begun by a mount
// or a reload.
export type Reading = { state: "reading" } | { state: "ended"; end: RecordingEnd } | { state: "failed"; error: Error };

export type Sink = { reset: () => void; append: (batch: RecordedEvent[]) => void };

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// Reads the recording open into `sink` from its start, reporting where the read stands to `changed`, until `signal`
// aborts it. Live or past, it is the one read (docs/design/01-mvp.md, "One path to the screen").
// [LAW:no-ambient-temporal-coupling] The read owns its batch: events arriving between frames are appended in one call
// at the next, because catching up delivers thousands in quick succession and one copy and render each would be
// quadratic. Its end and its failure append what is pending first, so no frame of the read
// runs after it has ended; its abort cancels the frame.
export function readRecording(connection: Pick<Connection, "recordings" | "read">, open: OpenRecording, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
  sink.reset();
  changed({ state: "reading" });
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
  const reader = {
    event: (event: RecordedEvent) => {
      if (pending.push(event) === 1) cancelFrame = frames(flush);
    },
    end: (end: RecordingEnd) => settle({ state: "ended", end }),
    failed: (error: Error) => settle({ state: "failed", error }),
  };
  connection
    .recordings(signal)
    .then((listings) => connection.read(listed(listings, open).name, reader, signal))
    // An abort rejects what it cut short; that is the read being stopped, not failing.
    .catch((error: Error) => signal.aborted || changed({ state: "failed", error }));
}

// The listing of the recording open.
// [LAW:no-silent-failure] A past recording not listed fails here, by its name: read anyway, the browser would report
// its 404 as a request not served, naming no recording.
function listed(listings: Listing[], open: OpenRecording): Listing {
  const matching = listings.filter((listing) => isOpen(open, listing));
  if (matching.length !== 1) throw new Error(`GET /recordings listed ${matching.length} recordings for ${JSON.stringify(open)}, not one`);
  return matching[0]!;
}

const animationFrames: Frames = (callback) => {
  const frame = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(frame);
};

// The recording open, read into the store for as long as the component using it is mounted, and read again from its
// start each time one is opened (view.open).
export function useRecording(connection: Connection, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, open, events, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, open]);
  return reading;
}
