import type { LogLine } from "@cc-dump/log/line";
import { useEffect, useReducer } from "react";
import { parts, type Connection, type Part } from "./connection/connection.ts";
import type { ReadLog } from "./log.ts";

// The parts whose logs the panel lists: those the connection reaches, and the UI, whose log is the page's own (log.ts).
export const logParts = [...parts, "ui"] as const;
export type LogPart = (typeof logParts)[number];

// [LAW:types-are-the-program] Where the UI's connection to a part's log stands: being made, made, lost or not made and
// being tried again, or ended, not served or sending what is no log's. The UI's own is made as the page is.
export type LogConnection = { state: "connecting" } | { state: "connected" } | { state: "dropped" } | { state: "failed"; error: Error };

// A line as the panel lists it: its part, the line, and when its work ended, which orders it among the other parts'.
export type Listed = { part: LogPart; line: LogLine; ended: number };

// The logs panel's state (docs/design/01-features.md, F9). `lines`: every part's lines, in the order their work ended,
// the last `kept` of them. `notKept`: how many lines any part wrote that are not among them, read off the gaps in the
// numbers of a process's lines, and the lines let go here. `last`: the last line read of each part's process.
export type Logs = {
  lines: Listed[];
  connections: Record<LogPart, LogConnection>;
  notKept: number;
  last: Partial<Record<LogPart, Pick<LogLine, "run" | "seq">>>;
};

export type LogsChange = { part: LogPart; line: LogLine } | { part: Part; connection: LogConnection };

export const noLogs: Logs = { lines: [], connections: { proxy: { state: "connecting" }, server: { state: "connecting" }, ui: { state: "connected" } }, notKept: 0, last: {} };

// How many lines the panel holds: more than either part keeps (processLog's 1000), so a restart's lines stay beside the
// ones before it, and few enough to list without a virtualizer.
const kept = 2000;

export function logsChanged(logs: Logs, change: LogsChange): Logs {
  if ("connection" in change) return { ...logs, connections: { ...logs.connections, [change.part]: change.connection } };
  const { part, line } = change;
  const before = logs.last[part];
  // The line after the last one read of the same process, or a process's first, which is line 0.
  const expected = before?.run === line.run ? before.seq + 1 : 0;
  // [LAW:single-enforcer] A line already read is not listed again: a connection made anew (the UI's code reloaded, the
  // panel's state kept) is sent its process's kept lines from the first.
  if (line.seq < expected) return logs;
  // A line not read has no time of its own, so it is listed where it arrived, last.
  const ended = "event" in line ? Date.parse(line.event.started_at) + line.event.duration_ms : (logs.lines.at(-1)?.ended ?? -Infinity);
  const listed: Listed = { part, line, ended };
  // A process writes its lines in the order their work ends, so a line goes near the end: among the other parts' lines
  // by when its work ended, and after its own part's, which were written before it, whatever the times say (a time is
  // to the millisecond).
  let at = logs.lines.length;
  while (at > 0 && logs.lines[at - 1]!.part !== part && logs.lines[at - 1]!.ended > listed.ended) at--;
  const lines = [...logs.lines.slice(0, at), listed, ...logs.lines.slice(at)];
  const letGo = Math.max(0, lines.length - kept);
  return {
    lines: lines.slice(letGo),
    connections: { ...logs.connections, [part]: { state: "connected" } },
    notKept: logs.notKept + (line.seq - expected) + letGo,
    last: { ...logs.last, [part]: { run: line.run, seq: line.seq } },
  };
}

// Every part's log, read for as long as the component using it is mounted: each part's kept lines, then each as it is
// written. The UI's is the page's, `page`.
export function useLogs(connection: Pick<Connection, "logs">, page: ReadLog): Logs {
  const [logs, change] = useReducer(logsChanged, noLogs);
  useEffect(() => {
    const abort = new AbortController();
    page((line) => change({ part: "ui", line }), abort.signal);
    for (const part of parts) {
      connection.logs(
        part,
        {
          opened: () => change({ part, connection: { state: "connected" } }),
          line: (line) => change({ part, line }),
          dropped: () => change({ part, connection: { state: "dropped" } }),
          failed: (error) => change({ part, connection: { state: "failed", error } }),
        },
        abort.signal,
      );
    }
    return () => abort.abort();
  }, [connection, page]);
  return logs;
}
