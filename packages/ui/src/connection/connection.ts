import type { LogLine } from "@cc-dump/log/line";
import type { Listing, ProxyStatus, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import type { Launch, Launched, Launcher, TmuxWindow } from "@cc-dump/server/format";
import type { TerminalConnection } from "@promptctl/tmux-control-mode-js/window-terminal";

// [LAW:locality-or-seam] The UI's one way to the backend: it names recordings, reads them, follows the proxy's status
// and each part's log, and launches agents, and how they are reached is the implementation's alone (the browser on the proxy's reader and
// the app server today; an Electron shell later).
export type Connection = {
  // The recordings, by name.
  recordings: (signal: AbortSignal) => Promise<Listing[]>;
  // Reads a recording from its start, then, while it is followed (the proxy run holds its writer), each event as it is
  // written. A read ends in exactly one way: its recording ends, it fails, or `signal` aborts it, which reports
  // nothing. A signal already aborted throws its reason, as `fetch` does.
  read: (name: string, reader: Reader, signal: AbortSignal) => void;
  // The proxy's status, what the proxy is among it, now and at each change, across restarts of the proxy (the restarted proxy's status follows),
  // until `signal` aborts it, which reports nothing, or the status is not served, which fails it. A status it cannot
  // read is reported as failed, and the statuses after it still arrive. Its connection is the UI's to the proxy: one
  // lost, or not made, is reported as dropped while it is tried again, and the next status says it is back. A signal
  // already aborted throws its reason.
  status: (watcher: StatusWatcher, signal: AbortSignal) => void;
  // The log lines of `part` (F9): the ones it kept, then each as it is written, across its restarts (the restarted
  // process's lines follow), until `signal` aborts it, which reports nothing. A line whose event it cannot read is
  // delivered unread, and the lines after it still arrive; a log that sends a message with no line's position is
  // reported as failed, and ends. A connection lost, or not made, is reported as dropped while it is tried again, and as
  // opened once it is made. A signal already aborted throws its reason.
  logs: (part: Part, watcher: LogWatcher, signal: AbortSignal) => void;
  // Makes a new recording for an agent started by hand (F8), each call a new one, which the proxy follows from its
  // first event.
  agentRecording: () => Promise<Listing>;
  // The launch settings and the sessions on the user's tmux server, read now (docs/design/01-features.md, F1). A refusal
  // fails it in the app server's words, tmux's own when tmux refused, as when it has no server or no sessions.
  launcher: (signal: AbortSignal) => Promise<Launcher>;
  // Stores the settings asked for as the next launch's, then opens the agent's window. Fails as `launcher` does.
  launch: (launch: Launch, signal: AbortSignal) => Promise<Launched>;
  // A new connection to `window` on the user's tmux server, which a terminal shows it through (F13), not yet connected:
  // its owner connects it and closes it.
  tmux: (window: TmuxWindow) => TmuxConnection;
};

// [LAW:no-ambient-temporal-coupling] A connection to a window, owned by whoever made it: `connect` opens it, and
// reconnects it after `close`; `close` ends it at once, with no call left pending and no retry left armed. A connection
// that drops retries on its own, a bounded number of times, then stays closed.
export type TmuxConnection = TerminalConnection & { connect: () => Promise<void>; close: () => Promise<void> };

export type StatusWatcher = {
  status: (status: ProxyStatus) => void;
  dropped: () => void;
  failed: (error: Error) => void;
};

// The parts that write a log: the proxy and the app server.
export const parts = ["proxy", "server"] as const;
export type Part = (typeof parts)[number];

export type LogWatcher = {
  opened: () => void;
  line: (line: LogLine) => void;
  dropped: () => void;
  failed: (error: Error) => void;
};

export type Reader = {
  event: (event: RecordedEvent) => void;
  end: (end: RecordingEnd) => void;
  failed: (error: Error) => void;
};
