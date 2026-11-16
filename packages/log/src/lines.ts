import { randomBytes } from "node:crypto";
import type { Writable } from "node:stream";
import { createLog, describeError, startSpan, type Handler, type Log } from "./index.ts";

// [LAW:single-enforcer] A part's log, the one its process writes: each event a JSON line on `out`, stdout, which
// `pnpm dev` shows in its terminal, and kept, the last `keep` of them, for the logs panel (docs/design/01-mvp.md, F9),
// which `logs` serves. The lines are numbered from 0 under `run`, an id of this process, so a reader that reconnects to
// the same process resumes after the last line it read, and one that reaches a process restarted since reads it anew.
// [LAW:no-silent-failure] `out` failing, as stdout does once the process reading it is gone (EPIPE), is no crash: the
// lines stop going to it, and its `stdout` event says why, in the lines kept, which the panel shows.
export function processLog(service: string, out: Writable = process.stdout, keep = 1000): { log: Log; logs: Handler } {
  const run = randomBytes(8).toString("hex");
  const kept: string[] = [];
  let written = 0;
  const readers = new Set<(seq: number, line: string) => void>();
  let writing = true;
  const span = startSpan();

  const log = createLog(service, (line) => {
    if (writing) out.write(line);
    const seq = written++;
    kept.push(line);
    if (kept.length > keep) kept.shift();
    for (const read of readers) read(seq, line);
  });
  out.on("error", (error) => {
    if (!writing) return;
    writing = false;
    log({ event: "stdout", ...span.end(), outcome: "error", error: describeError(error) });
  });

  // `GET /logs`: Server-Sent Events, each line kept and then each one written, until the reader leaves or the server
  // closes. A line kept no longer is not sent: the reader sees the gap in the numbers.
  const logs: Handler = (req, res) => {
    if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (seq: number, line: string) => void res.write(`id: ${run}:${seq}\ndata: {"run":"${run}","seq":${seq},"event":${line.trimEnd()}}\n\n`);
    const first = written - kept.length;
    const from = Math.max(first, resumedAfter(req.headers["last-event-id"], run) + 1);
    kept.slice(from - first).forEach((line, at) => send(from + at, line));
    readers.add(send);
    res.on("close", () => readers.delete(send));
  };

  return { log, logs };
}

// The last line a reconnecting EventSource read from this process, `run`, by the id it sends back, which is one header;
// -1 when it read none of this process's (a first connection, or one from before a restart).
function resumedAfter(lastEventId: string | string[] | undefined, run: string): number {
  const [from, seq] = typeof lastEventId === "string" ? lastEventId.split(":") : [];
  return from === run && /^\d+$/.test(seq ?? "") ? Number(seq) : -1;
}
