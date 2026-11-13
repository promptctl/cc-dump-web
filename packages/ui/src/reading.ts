import type { Listing, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { events } from "./store.ts";

// The recording open (docs/design/01-mvp.md, F7): the live one, whichever run is live now, or a past one by its name.
// [LAW:types-are-the-program] The live one is named by its role: its name changes with every run of the proxy.
export type OpenRecording = { recording: "live" } | { recording: "past"; name: string };

// Whether `listing` is the recording open: the one listed as live, or the one listed by its name.
export function isOpen(open: OpenRecording, listing: Listing): boolean {
  return open.recording === "live" ? listing.live : listing.name === open.name;
}

// The recording a listing opens: the one listed as live opens live, never as a past one by the name it has now.
export function opening(listing: Listing): OpenRecording {
  return listing.live ? { recording: "live" } : { recording: "past", name: listing.name };
}

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
  nameOf(connection, open, signal)
    .then((name) => connection.read(name, reader, signal))
    // An abort rejects what it cut short; that is the read being stopped, not failing.
    .catch((error: Error) => signal.aborted || changed({ state: "failed", error }));
}

// The name of the recording open: a past one's own, and the live one's from the listing, since it changes with every
// run of the proxy. [LAW:single-enforcer] Whether a recording by that name exists is the reader's to answer, with a
// read it does not serve.
async function nameOf(connection: Pick<Connection, "recordings">, open: OpenRecording, signal: AbortSignal): Promise<string> {
  switch (open.recording) {
    case "past":
      return open.name;
    case "live": {
      const live = (await connection.recordings(signal)).filter((listing) => listing.live);
      if (live.length !== 1) throw new Error(`GET /recordings listed ${live.length} live recordings, not one`);
      return live[0]!.name;
    }
  }
}

const animationFrames: Frames = (callback) => {
  const frame = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(frame);
};

// The recording open, read into the store for as long as the component using it is mounted, and read again from its
// start each time one is opened.
export function useRecording(connection: Connection, open: OpenRecording): Reading {
  const [reading, setReading] = useState<Reading>({ state: "reading" });
  useEffect(() => {
    const abort = new AbortController();
    readRecording(connection, open, events, animationFrames, abort.signal, setReading);
    return () => abort.abort();
  }, [connection, open]);
  return reading;
}
