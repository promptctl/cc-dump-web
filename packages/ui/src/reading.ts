import type { RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { events } from "./store.ts";

// [LAW:types-are-the-program] Where a read stands. The live recording ends only once the proxy that wrote it has
// stopped: the browser reconnects to it, finished now, and reads its end. A new run is a new read, begun by a mount
// or a reload.
export type Reading = { state: "reading" } | { state: "ended"; end: RecordingEnd } | { state: "failed"; error: Error };

export type Sink = { reset: () => void; append: (batch: RecordedEvent[]) => void };

// A frame clock: runs `callback` at the next frame, and returns the function that cancels it.
export type Frames = (callback: () => void) => () => void;

// Reads the live recording into `sink` from its start, reporting where the read stands to `changed`, until `signal`
// aborts it. [LAW:no-ambient-temporal-coupling] The read owns its batch: events arriving between frames are
// appended in one call at the next, because catching up delivers thousands in quick succession and one copy and
// render each would be quadratic. Its end and its failure append what is pending first, so no frame of the read
// runs after it has ended; its abort cancels the frame.
export function readLive(connection: Pick<Connection, "recordings" | "read">, sink: Sink, frames: Frames, signal: AbortSignal, changed: (reading: Reading) => void) {
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
    .then((listings) => {
      const live = listings.filter((listing) => listing.live);
      if (live.length !== 1) throw new Error(`GET /recordings listed ${live.length} live recordings, not one`);
      connection.read(live[0]!.name, reader, signal);
    })
    // An abort rejects what it cut short; that is the read being stopped, not failing.
    .catch((error: Error) => signal.aborted || changed({ state: "failed", error }));
}

const animationFrames: Frames = (callback) => {
  const frame = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(frame);
};

// The live recording, read into the store for as long as the component using it is mounted.
export function useLiveRecording(connection: Connection): Reading {
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  useEffect(() => {
    const abort = new AbortController();
    readLive(connection, events, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection]);
  return reading;
}
