import type { Listing, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";

// [LAW:locality-or-seam] The UI's one way to the backend: it names recordings and reads them, and how they are
// reached is the implementation's alone (the browser on the proxy's reader today; an Electron shell later).
export type Connection = {
  // The recordings, oldest first.
  recordings: (signal: AbortSignal) => Promise<Listing[]>;
  // Reads a recording from its start, then, while it is live, each event as it is written. A read ends in exactly
  // one way: its recording ends, it fails, or `signal` aborts it, which reports nothing.
  read: (name: string, reader: Reader, signal: AbortSignal) => void;
};

export type Reader = {
  event: (event: RecordedEvent) => void;
  end: (end: RecordingEnd) => void;
  failed: (error: Error) => void;
};
