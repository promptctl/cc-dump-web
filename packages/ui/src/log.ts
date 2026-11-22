import { describe } from "@cc-dump/log/describe";
import { createLog, unitsOf, type Log } from "@cc-dump/log/event";
import { keptLines } from "@cc-dump/log/kept";
import { parseLogLine, type LogLine } from "@cc-dump/log/line";

// The UI's units of work, written by the parts' one writer, each error in the words a person is shown.
export const { failed, unitOfWork, loggedAfter } = unitsOf(describe);

// What a reader of a log is handed: each line kept, then each one written, until `signal` aborts.
export type ReadLog = (line: (line: LogLine) => void, signal: AbortSignal) => void;

// [LAW:single-enforcer] [LAW:nothing-unseen] The page's log, the one the UI writes as `ui`: its events in the parts'
// shape, kept, the last `keep` of them, as a part's process keeps its own (kept.ts), for the logs panel to list beside
// the parts' (docs/design/01-features.md, F9). Each line is read as the panel reads a part's, so a UI line is a part's
// line in every way but where it comes from.
export function pageLog(keep = 1000): { log: Log; read: ReadLog } {
  const lines = keptLines(keep);
  const read: ReadLog = (line, signal) => {
    let next = lines.first();
    const send = () => {
      for (next = Math.max(next, lines.first()); next < lines.written(); next++) line(parseLogLine(lines.line(next).trimEnd(), `${lines.run}:${next}`));
    };
    send();
    signal.addEventListener("abort", lines.watch(send), { once: true });
  };
  return { log: createLog("ui", lines.write), read };
}

export type PageLog = ReturnType<typeof pageLog>;
