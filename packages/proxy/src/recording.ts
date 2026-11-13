import { closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describeError, startSpan, type Ending, type Log } from "@cc-dump/log";

export type Header = [name: string, value: string];

// What the proxy saw of one exchange, as it saw it. A message's trailers are seen when its body is
// complete, none if it had none, so a body cut short has no trailers event.
export type Seen =
  | { type: "request"; method: string; url: string; http_version: string; headers: Header[] }
  | { type: "request_body"; chunk: Buffer }
  | { type: "request_trailers"; headers: Header[] }
  | { type: "response"; status: number; reason: string; http_version: string; headers: Header[] }
  | { type: "response_body"; chunk: Buffer }
  | { type: "response_trailers"; headers: Header[] }
  | ({ type: "end" } & Ending);

// [LAW:one-source-of-truth] The recording format: one JSON line per event, in the order the proxy saw
// them, joined into exchanges by the trace_id of the request's log event; overlapping exchanges interleave.
// [LAW:decomposition] It holds the wire, not an interpretation of it: headers in arrival order, case and
// repetition, trailers too; body chunks as the bytes received (a gzip body stays gzip), so later parsing applies to old
// recordings too. An exchange ends with the ending its log event records.
export type RecordedEvent = { timestamp: string; trace_id: string } & (
  | Exclude<Seen, { chunk: Buffer }>
  | { type: Extract<Seen, { chunk: Buffer }>["type"]; base64: string }
);

// One exchange's recording, opened when its request arrives.
export type Recorder = (trace_id: string) => (seen: Seen) => void;

// The run's recording: where it is, how to record an exchange into it, and the writer's word on its growth,
// which only the writer knows. `written` is the length in bytes of the whole events written so far, all a
// reader may read: past it the file may hold what the last write left when it failed, and before the first event
// there may be no file. Each `onAppend` listener is called after every append until the function it
// returned is called.
export type Recording = {
  name: string;
  path: string;
  record: Recorder;
  written: () => number;
  onAppend: (listener: () => void) => () => void;
};

// Each event is appended before the next is handled, so a proxy killed at any moment leaves every event
// it saw up to then, and no traffic leaves no file.
// [LAW:one-source-of-truth] The file is the run's own and its length is the writer's: the first write
// creates it, refusing a file already at the path, and each write cuts the file back to `written` before
// writing the event there. So what a failed write left (part of its line, or all of it when only the
// close failed) is gone at the next write, every line below `written` is a whole event, and those bytes
// never change once written.
// [LAW:nothing-unseen] An exchange's recording is its own unit of work, in the exchange's trace: its
// event, written with `end`, counts what was written and what failed, and names the first failure. A
// write that fails is counted and never stops or alters the agent's traffic. Writes are synchronous,
// so a disk that stalls stalls forwarding with it: that is the price of the kill guarantee above.
export function createRecording(log: Log, path: string): Recording {
  mkdirSync(dirname(path), { recursive: true });
  let written = 0;
  // "wx" until a write has created the file, then "r+": open the file that is there, which is this run's.
  let flags = "wx";
  const listeners = new Set<() => void>();
  const record: Recorder = (trace_id) => {
    const span = startSpan(trace_id);
    const counts = { events_written: 0, bytes_written: 0, events_failed: 0 };
    let failure: string | undefined;
    return (seen) => {
      const event: RecordedEvent = { timestamp: new Date().toISOString(), trace_id, ...recorded(seen) };
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      try {
        const fd = openSync(path, flags);
        flags = "r+";
        writeAt(fd, written, line);
        counts.events_written++;
        counts.bytes_written += line.length;
        written += line.length;
        for (const listener of listeners) listener();
      } catch (error) {
        counts.events_failed++;
        failure ??= describeError(error);
      }
      if (seen.type !== "end") return;
      const ending: Ending = failure === undefined ? { outcome: "ok" } : { outcome: "error", error: failure };
      log({ event: "record", ...span.end(), ...ending, path, counts });
    };
  };
  return {
    name: basename(path),
    path,
    record,
    written: () => written,
    onAppend: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// Cuts the file to `position`, then writes all of `bytes` there and closes it, or throws: a write that
// comes back short is carried on from where it stopped, as appendFileSync does.
function writeAt(fd: number, position: number, bytes: Buffer) {
  try {
    ftruncateSync(fd, position);
    for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done, bytes.length - done, position + done);
  } finally {
    closeSync(fd);
  }
}

function recorded(seen: Seen) {
  switch (seen.type) {
    case "request":
    case "request_trailers":
    case "response":
    case "response_trailers":
      return { ...seen, headers: seen.headers.filter(([name]) => !secret.has(name.toLowerCase())) };
    case "request_body":
    case "response_body":
      return { type: seen.type, base64: seen.chunk.toString("base64") };
    case "end":
      return seen;
  }
}

// [LAW:single-enforcer] The credential headers of HTTP and of the Anthropic API, which the proxy fronts:
// forwarded to the upstream and the agent, and never written.
const secret = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie", "set-cookie"]);
