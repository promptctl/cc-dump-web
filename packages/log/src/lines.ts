import { randomBytes } from "node:crypto";
import type { Writable } from "node:stream";
import { stream, type Route } from "./answer.ts";
import { createLog, failed, startTrace, unitOfWork, type Log } from "./index.ts";
import { positionOf } from "./line.ts";
import { frame } from "./wire.ts";

// [LAW:single-enforcer] A part's log, the one its process writes: each event a JSON line on `out`, stdout, which
// `pnpm dev` shows in its terminal, and kept, the last `keep` of them, for the logs panel (docs/design/01-features.md, F9),
// which `logs` serves. The lines are numbered from 0 under `run`, an id of this process, so a reader that reconnects to
// the same process resumes after the last line it read, and one that reaches a process restarted since reads it anew.
// [LAW:no-silent-failure] `out` failing, as stdout does once the process reading it is gone (EPIPE), is no crash: the
// lines stop going to it, and its `stdout` event says why, in the lines kept, which the panel shows. The event spans
// stdout's life, from the process's start to its failure, as a connection's `client_error` spans the connection.
export function processLog(service: string, out: Writable = process.stdout, keep = 1000): { log: Log; logs: Route } {
  const run = randomBytes(8).toString("hex");
  // A ring buffer: line `seq` is at `seq % keep` until `keep` more are written over it.
  const kept: string[] = [];
  let written = 0;
  const first = () => Math.max(0, written - keep);
  const readers = new Set<() => void>();
  let writing = true;

  const log = createLog(service, (line) => {
    if (writing) out.write(line);
    kept[written++ % keep] = line;
    for (const send of readers) send();
  });
  const stdout = unitOfWork(log, "stdout", {}, startTrace());
  // `out` is let go first, so the event's own line goes only to the lines kept.
  out.on("error", (error) => {
    writing = false;
    stdout.end(failed(error));
  });

  // `GET /logs`: Server-Sent Events, each line kept and then each one written, until the reader leaves or the server
  // closes. A reader is sent lines while its connection takes them and the rest once it drains, so one that stops
  // reading holds none of them; a line let go before it is sent is not sent, and the reader sees the gap in the numbers.
  const logs: Route = (req) =>
    stream((res) => {
      let next = resumedAfter(req.headers["last-event-id"], run) + 1;
      let full = false;
      const send = () => {
        for (next = Math.max(next, first()); !full && next < written; next++) full = !res.write(frame({ id: `${run}:${next}`, data: kept[next % keep]!.trimEnd() }));
      };
      send();
      readers.add(send);
      res.on("drain", () => {
        full = false;
        send();
      });
      res.on("close", () => readers.delete(send));
    });

  return { log, logs };
}

// The last line a reconnecting EventSource read from this process, `run`, by the id it sends back, which is one header;
// -1 when it read none of this process's (a first connection, or one from before a restart).
function resumedAfter(lastEventId: string | string[] | undefined, run: string): number {
  const read = typeof lastEventId === "string" ? positionOf(lastEventId) : undefined;
  return read?.run === run ? read.seq : -1;
}
