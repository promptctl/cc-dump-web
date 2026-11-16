import type { LogLine } from "@cc-dump/log/line";
import { describe, expect, it } from "vitest";
import { logsChanged, noLogs, type Logs, type LogsChange } from "./logs.ts";

// Line `seq` of process `run`, whose work started at second `at` and took `ms`.
const line = (run: string, seq: number, at: number, ms = 0): LogLine => ({
  run,
  seq,
  event: { service: "proxy", event: `${run}${seq}`, started_at: new Date(Date.UTC(2026, 10, 16, 9, 0, at)).toISOString(), duration_ms: ms, outcome: "ok", facts: {} },
});

const after = (...changes: LogsChange[]): Logs => changes.reduce(logsChanged, noLogs);
const names = (logs: Logs) => logs.lines.map(({ line }) => ("event" in line ? line.event.event : "unread"));

describe("logsChanged", () => {
  it("lists both parts' lines in the order their work ended, and says each part's log is reached", () => {
    const logs = after(
      { part: "proxy", line: line("p", 0, 1) },
      { part: "proxy", line: line("p", 1, 5) },
      // The app server's work ended between the proxy's two, though it arrived after them.
      { part: "server", line: line("s", 0, 2, 1000) },
    );
    expect(names(logs)).toEqual(["p0", "s0", "p1"]);
    expect(logs.connections).toEqual({ proxy: { state: "connected" }, server: { state: "connected" } });
  });

  it("counts the lines a part did not keep: before the first one sent, and between two of the same process", () => {
    expect(after({ part: "proxy", line: line("p", 3, 1) }).notKept).toBe(3);
    expect(after({ part: "proxy", line: line("p", 0, 1) }, { part: "proxy", line: line("p", 4, 2) }).notKept).toBe(3);
  });

  it("reads a restarted process's lines from its first", () => {
    const logs = after({ part: "server", line: line("old", 0, 1) }, { part: "server", line: line("old", 1, 2) }, { part: "server", line: line("new", 0, 3) });
    expect([names(logs), logs.notKept]).toEqual([["old0", "old1", "new0"], 0]);
  });

  it("lists a line already read once, as a connection made anew is sent the kept lines again", () => {
    const logs = after({ part: "proxy", line: line("p", 0, 1) }, { part: "proxy", line: line("p", 1, 2) }, { part: "proxy", line: line("p", 0, 1) }, { part: "proxy", line: line("p", 1, 2) }, { part: "proxy", line: line("p", 2, 3) });
    expect([names(logs), logs.notKept]).toEqual([["p0", "p1", "p2"], 0]);
  });

  it("lists a part's lines in the order its process wrote them, whatever their times say", () => {
    // p1's work ended a fraction of a millisecond after p0's, but its start was written to the millisecond.
    const logs = after({ part: "proxy", line: line("p", 0, 1, 2) }, { part: "proxy", line: line("p", 1, 1, 1) }, { part: "server", line: line("s", 0, 1, 0) });
    expect(names(logs)).toEqual(["s0", "p0", "p1"]);
  });

  it("lists a line it could not read where it arrived, in its place in its process's numbers", () => {
    const unread = { run: "p", seq: 1, unread: "{", error: "log line: is not JSON" };
    const logs = after({ part: "proxy", line: line("p", 0, 5) }, { part: "proxy", line: unread }, { part: "proxy", line: line("p", 2, 6) });
    expect([logs.lines.map(({ line }) => line.seq), logs.notKept, logs.connections.proxy]).toEqual([[0, 1, 2], 0, { state: "connected" }]);
  });

  it("holds the last 2000 lines, counting the ones it let go", () => {
    const changes = Array.from({ length: 2003 }, (_, seq): LogsChange => ({ part: "proxy", line: line("p", seq, 0, seq) }));
    const logs = after(...changes);
    expect([logs.lines.length, logs.lines[0]!.line.seq, logs.notKept]).toEqual([2000, 3, 3]);
  });

  it("says a part's log is lost while it is tried again, and why one failed", () => {
    const error = new Error("GET http://127.0.0.1:3346/logs: not served");
    expect(after({ part: "proxy", connection: { state: "dropped" } }).connections.proxy).toEqual({ state: "dropped" });
    expect(after({ part: "server", connection: { state: "failed", error } }).connections).toEqual({ proxy: { state: "connecting" }, server: { state: "failed", error } });
  });
});
