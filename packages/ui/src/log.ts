import { describe } from "@cc-dump/log/describe";
import type { Ending } from "@cc-dump/log/ending";
import { createLog, unitsOf, type Facts, type Log, type Span } from "@cc-dump/log/event";
import { keptLines } from "@cc-dump/log/kept";
import { lineAt, type LogLine } from "@cc-dump/log/line";

// The UI's units of work, written by the parts' one writer, each error in the words a person is shown.
export const { failed, unitOfWork } = unitsOf(describe);

// [LAW:single-enforcer] A decision the UI took about the reader's view or what it keeps: a unit of work that ends as it
// is taken, on `span`, as `ending` says.
export const decided = (log: Log, event: string, facts: Facts, ending: Ending, span: Span) => unitOfWork(log, event, facts, span).end(ending);

// What a reader of a log is handed: each line kept, then each one written, until `signal` aborts. A signal already
// aborted throws its reason, as the connection's reads do.
export type ReadLog = (line: (line: LogLine) => void, signal: AbortSignal) => void;

// [LAW:single-enforcer] [LAW:nothing-unseen] The page's log, the one the UI writes as `ui`: its events in the parts'
// shape, kept, the last `keep` of them, as a part's process keeps its own (kept.ts), for the logs panel to list beside
// the parts' (docs/design/01-features.md, F9). Each line is read as the panel reads a part's, so a UI line is a part's
// line in every way but where it comes from.
// [LAW:no-ambient-temporal-coupling] A reader is handed the lines written on a turn of its own, after the write
// returns, so the view's work that writes an event never runs the panel's reading of it.
export function pageLog(keep = 1000): { log: Log; read: ReadLog } {
  const lines = keptLines(keep);
  const read: ReadLog = (line, signal) => {
    signal.throwIfAborted();
    const next = lines.from(0);
    const send = () => {
      for (let kept; !signal.aborted && (kept = next()); ) line(lineAt(kept.position, kept.line));
    };
    send();
    signal.addEventListener("abort", lines.watch(() => queueMicrotask(send)), { once: true });
  };
  return { log: createLog("ui", lines.write), read };
}

export type PageLog = ReturnType<typeof pageLog>;
