import type { Listing, ProxyStatus, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import type { Launch, Launched, Launcher } from "@cc-dump/server/format";

// [LAW:locality-or-seam] The UI's one way to the backend: it names recordings, reads them, follows the proxy's status,
// and launches agents, and how they are reached is the implementation's alone (the browser on the proxy's reader and
// the app server today; an Electron shell later).
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
  // The launch settings and the sessions on the user's tmux server, read now (docs/design/01-mvp.md, F1). A refusal
  // fails it in the app server's words, tmux's own when tmux refused, as when it has no server or no sessions.
  launcher: (signal: AbortSignal) => Promise<Launcher>;
  // Stores the settings asked for as the next launch's, then opens the agent's window. Fails as `launcher` does.
  launch: (launch: Launch, signal: AbortSignal) => Promise<Launched>;
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
