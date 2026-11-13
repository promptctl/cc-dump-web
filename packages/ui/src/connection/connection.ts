import type { Listing, ProxyStatus, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";

// [LAW:locality-or-seam] The UI's one way to the backend: it names recordings, reads them, and follows the proxy's
// status, and how they are reached is the implementation's alone (the browser on the proxy's reader today; an
// Electron shell later).
export type Connection = {
  // The recordings, oldest first.
  recordings: (signal: AbortSignal) => Promise<Listing[]>;
  // Reads a recording from its start, then, while it is live, each event as it is written. A read ends in exactly
  // one way: its recording ends, it fails, or `signal` aborts it, which reports nothing. A signal already aborted
  // throws its reason, as `fetch` does.
  read: (name: string, reader: Reader, signal: AbortSignal) => void;
  // The proxy's status now and at each change, across restarts of the proxy (the restarted proxy's status follows),
  // until `signal` aborts it, which reports nothing, or the status is not served, which fails it. A status it cannot
  // read is reported as failed, and the statuses after it still arrive. A signal already aborted throws its reason.
  status: (watcher: StatusWatcher, signal: AbortSignal) => void;
};

export type StatusWatcher = {
  status: (status: ProxyStatus) => void;
  failed: (error: Error) => void;
};

export type Reader = {
  event: (event: RecordedEvent) => void;
  end: (end: RecordingEnd) => void;
  failed: (error: Error) => void;
};
