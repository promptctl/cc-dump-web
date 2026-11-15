import { appendFileSync, closeSync, constants, fstatSync, ftruncateSync, openSync, readSync } from "node:fs";
import type { Recorded, RecordedEvent } from "./format.ts";

const { O_APPEND, O_CREAT, O_WRONLY } = constants;

// What the proxy saw of one exchange, as it saw it: the recorded format, with body chunks as the bytes.
type Body = Extract<Recorded, { base64: string }>;
export type Seen = Exclude<Recorded, Body> | { type: Body["type"]; chunk: Buffer };

// One exchange's recording into the recording `name`, opened when its request arrives.
export type Recorder = (name: string, trace_id: string) => (seen: Seen) => void;

// [LAW:one-source-of-truth] The measure of a recording's file that every part uses, the one source of how much of it
// may be read: the bytes through its last newline, which are whole events, and the bytes after it, which a write that
// failed left. No file is neither. The writer starts there, and a reader of a recording with no writer stops there, so
// the bytes a writer will cut are never sent, and a recording continued after a crash never has a fragment glued onto
// its next event.
export function recordedLength(path: string): { terminated: number; unterminated: number } {
  let file: number;
  try {
    file = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { terminated: 0, unterminated: 0 };
    throw error;
  }
  try {
    const size = fstatSync(file).size;
    // From the end, a block at a time, to the last newline: a cut line may be longer than one block.
    const block = Buffer.allocUnsafe(16 * 1024);
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - block.length);
      const read = readSync(file, block, 0, end - start, start);
      const newline = block.subarray(0, read).lastIndexOf(0x0a);
      if (newline !== -1) return { terminated: start + newline + 1, unterminated: size - (start + newline + 1) };
      end = start;
    }
    return { terminated: 0, unterminated: size };
  } finally {
    closeSync(file);
  }
}

// One recording's file, and the writer's word on its growth, which only the writer knows. `written` is the length in
// bytes of the whole events in the file, all a reader may read: past it the file may hold what the last write left
// when it failed.
export type Writer = { written: () => number; append: (line: Buffer) => void };

// Each event is written before the next is handled, so a proxy killed at any moment leaves every event
// it saw up to then, and no traffic leaves no file.
// [LAW:one-source-of-truth] The writer starts at the recording's `recordedLength`, so one already at the path is
// continued after its last whole event: an agent outlives a proxy restart and goes on sending to its path. The first
// write creates the file if it is not there, and every later write opens it without creating it, so one deleted
// mid-run fails loudly. Each write cuts the file back to `written` before appending the event, so what a failed write
// left, or a crash, is gone at the next write, every line below `written` is a whole event, and those bytes never
// change once written.
export function createWriter(path: string): Writer {
  let written = recordedLength(path).terminated;
  let flags = O_WRONLY | O_APPEND | O_CREAT;
  return {
    written: () => written,
    append: (line) => {
      const fd = openSync(path, flags);
      flags = O_WRONLY | O_APPEND;
      appendAfter(fd, written, line);
      written += line.length;
    },
  };
}

// Cuts the file to `length`, appends `line` after it, and closes the file, or throws.
function appendAfter(fd: number, length: number, line: Buffer) {
  try {
    ftruncateSync(fd, length);
    appendFileSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

// The line the recording holds for `seen`: one JSON event, the credentials removed.
export function eventLine(trace_id: string, seen: Seen): Buffer {
  const event: RecordedEvent = { timestamp: new Date().toISOString(), trace_id, ...recorded(seen) };
  return Buffer.from(`${JSON.stringify(event)}\n`);
}

function recorded(seen: Seen): Recorded {
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
