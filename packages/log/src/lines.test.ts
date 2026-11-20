import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseLogLine, type LinePosition, type LoggedEvent } from "./line.ts";
import { processLog } from "./lines.ts";
import { serving, subscribe, traceIdOf, workEvent as event } from "./testing.ts";

// A stdout of the test's own: what was written to it, and the error a reader leaving it would raise.
function output() {
  const written: string[] = [];
  const out = new Writable({ write: (chunk: Buffer, _encoding, done) => void (written.push(chunk.toString()), done()) });
  return { out, written };
}

// The process log's lines served on a free port, read from the start, or after the line `lastEventId` names.
async function served(logs: Parameters<typeof serving>[0], lastEventId?: string) {
  const { port } = await serving(logs);
  return subscribe(port, "/logs", lastEventId === undefined ? {} : { "last-event-id": lastEventId });
}

// A line sent, which every line this log writes is: read, its event with it.
function read({ data, id }: { id?: string; data: string }): LinePosition & { event: LoggedEvent } {
  const line = parseLogLine(data, id!);
  if (!("event" in line)) throw new Error(`line ${id} unread: ${line.error}`);
  return line;
}
const eventOf = (sent: { id?: string; data: string }) => read(sent).event;

describe("processLog", () => {
  it("writes each event to stdout as its line and serves the lines, the ones kept and then each new one", async () => {
    const { out, written } = output();
    const { log, logs } = processLog("proxy", out);
    log(event("first"));
    expect(written).toEqual([`${JSON.stringify({ service: "proxy", ...event("first") })}\n`]);
    const { take } = await served(logs);
    log(event("second"));
    const lines = (await take(2)).map((sent) => ({ id: sent.id, line: read(sent) }));
    expect(lines.map(({ line }) => [line.seq, line.event.service, line.event.event])).toEqual([
      [0, "proxy", "first"],
      [1, "proxy", "second"],
    ]);
    expect(lines[0]!.id).toMatch(/^[0-9a-f]{16}:0$/);
    expect(lines[0]!.line.event).toEqual({ service: "proxy", event: "first", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 1.5, outcome: "ok", facts: { trace_id: traceIdOf("t") } });
  });

  it("keeps the last lines only, numbered as they were written, so a reader sees how many it was not sent", async () => {
    const { out } = output();
    const { log, logs } = processLog("server", out, 2);
    for (const name of ["a", "b", "c"]) log(event(name));
    const lines = (await (await served(logs)).take(2)).map(read);
    expect(lines.map(({ seq, event }) => [seq, event.event])).toEqual([
      [1, "b"],
      [2, "c"],
    ]);
  });

  it("sends a reader that stops reading no more than its connection takes, the lines let go meanwhile a gap it sees", async () => {
    const { out } = output();
    const { log, logs } = processLog("proxy", out, 10);
    const { res, next } = await served(logs);
    res.pause();
    for (let n = 0; n < 10_000; n++) log({ ...event(`e${n}`), padding: "x".repeat(1000) });
    res.resume();
    const seqs: number[] = [];
    while (seqs.at(-1) !== 9_999) seqs.push(read(await next()).seq);
    expect(seqs.length).toBeLessThan(1000);
    expect(seqs.slice(-10)).toEqual(Array.from({ length: 10 }, (_, n) => 9_990 + n));
  });

  it("resumes a reconnect to the same process after the last line it read, and serves a restarted process's anew", async () => {
    const { out } = output();
    const { log, logs } = processLog("server", out);
    for (const name of ["a", "b", "c"]) log(event(name));
    const [first] = await (await served(logs)).take(1);
    const resumed = await (await served(logs, first!.id)).take(2);
    expect(resumed.map((sent) => eventOf(sent).event)).toEqual(["b", "c"]);
    const anew = await (await served(logs, "another-run:2")).take(1);
    expect(read(anew[0]!).seq).toBe(0);
  });

  it("stops writing to a stdout whose reader is gone, and says so in the lines it serves", async () => {
    const { out, written } = output();
    const { log, logs } = processLog("proxy", out);
    out.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    out.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    log(event("after"));
    expect(written).toEqual([]);
    const lines = (await (await served(logs)).take(2)).map(eventOf);
    expect(lines[0]).toMatchObject({ event: "stdout", outcome: "error", error: expect.stringContaining("write EPIPE") });
    expect(lines[1]).toMatchObject({ event: "after" });
  });
});
