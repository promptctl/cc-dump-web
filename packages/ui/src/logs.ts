import type { LogLine } from "@cc-dump/log/line";
import { useEffect, useReducer } from "react";
import { parts, type Connection, type Part } from "./connection/connection.ts";

// [LAW:types-are-the-program] Where the UI's connection to a part's log stands: being made, made, lost or not made and
// being tried again, or ended, not served or sending what is no log's.
export type LogConnection = { state: "connecting" } | { state: "connected" } | { state: "dropped" } | { state: "failed"; error: Error };

// A line as the panel lists it: its part, the line, when its work ended, which orders it among the other part's, and
// whether it is the first read of its part's process after another's, whose lines written once the panel's connection
// to it was cut (its shutdown's, which come after) the panel never reads.
export type Listed = { part: Part; line: LogLine; ended: number; restarted: boolean };

// The logs panel's state (docs/design/01-mvp.md, F9). `lines`: both parts' lines, in the order their work ended, the
// last `kept` of them. `notKept`: how many lines either part wrote that are not among them, read off the gaps in the
// numbers of a process's lines, and the lines let go here. `last`: the last line read of each part's process.
export type Logs = {
  lines: Listed[];
  connections: Record<Part, LogConnection>;
  notKept: number;
  last: Partial<Record<Part, Pick<LogLine, "run" | "seq">>>;
};

export type LogsChange = { part: Part; line: LogLine } | { part: Part; connection: LogConnection };

export const noLogs: Logs = { lines: [], connections: { proxy: { state: "connecting" }, server: { state: "connecting" } }, notKept: 0, last: {} };

// How many lines the panel holds: more than either part keeps (processLog's 1000), so a restart's lines stay beside the
// ones before it, and few enough to list without a virtualizer.
const kept = 2000;

export function logsChanged(logs: Logs, change: LogsChange): Logs {
  if ("connection" in change) return { ...logs, connections: { ...logs.connections, [change.part]: change.connection } };
  const { part, line } = change;
  const before = logs.last[part];
  // The line after the last one read of the same process, or a process's first, which is line 0. A line comes after the
  // last one of its process (Connection.logs), so the gap is never negative.
  const expected = before?.run === line.run ? before.seq + 1 : 0;
  // A line not read has no time of its own, so it is listed where it arrived, last.
  const ended = "event" in line ? Date.parse(line.event.started_at) + line.event.duration_ms : (logs.lines.at(-1)?.ended ?? -Infinity);
  const listed: Listed = { part, line, ended, restarted: before !== undefined && before.run !== line.run };
  // A process writes its lines in the order their work ends, so a line goes near the end.
  let at = logs.lines.length;
  while (at > 0 && logs.lines[at - 1]!.ended > listed.ended) at--;
  const lines = [...logs.lines.slice(0, at), listed, ...logs.lines.slice(at)];
  const letGo = Math.max(0, lines.length - kept);
  return {
    lines: lines.slice(letGo),
    connections: { ...logs.connections, [part]: { state: "connected" } },
    notKept: logs.notKept + (line.seq - expected) + letGo,
    last: { ...logs.last, [part]: { run: line.run, seq: line.seq } },
  };
}

// Both parts' logs, read for as long as the component using it is mounted: each part's kept lines, then each as it is
// written.
export function useLogs(connection: Pick<Connection, "logs">): Logs {
  const [logs, change] = useReducer(logsChanged, noLogs);
  useEffect(() => {
    const abort = new AbortController();
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
  }, [connection]);
  return logs;
}
