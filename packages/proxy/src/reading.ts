import { readdir, open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { pipeline, Readable } from "node:stream";
import { describeError, startSpan, type Ending, type Handler, type Log } from "@cc-dump/log";
import type { Listing, ReadFailure, RecordingEnd } from "./format.ts";
import type { Recording } from "./recording.ts";

// [LAW:decomposition] The recording's read side, and the one path traffic takes to the screen
// (docs/design/01-mvp.md): live viewing, reopening, refresh and reload are all one read from a position.
// `GET /recordings` lists the recordings, oldest first (ISO 8601 basic names sort by time), the live one
// before its file exists. `GET /recordings/<name>` is Server-Sent Events, one per recorded line, whose id is
// the byte offset just past the line: a reconnecting EventSource resumes from it with `Last-Event-ID`.
// A finished recording ends with an `end` event; the live one is followed until the reader leaves. A read that
// fails once begun ends with a `failed` event: the stream's only way to tell a reader it failed, since an
// EventSource takes a cut stream for a dropped connection and reconnects into the same failure.
export function createReader(log: Log, live: Recording): Handler {
  const dir = dirname(live.path);
  return (req, res, { trace_id, fail, ended }) => {
    const url = new URL(req.url!, "http://reader");
    const asked = /^\/recordings\/([^/]+)$/.exec(url.pathname)?.[1];
    const answer = async () => {
      if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
      if (url.pathname === "/recordings") return list(await recordings(dir, live), live, res);
      // [LAW:parse-dont-validate] A name is one the listing holds, spelled as it holds it: nothing else in the
      // URL reaches the filesystem, and a case-insensitive filesystem cannot open the live recording by
      // another spelling and serve it as finished.
      const name = (await recordings(dir, live)).find((name) => name === asked);
      if (!name) return void res.writeHead(404).end();
      const reading = { log, trace_id, ended, name, path: join(dir, name), live: name === live.name ? live : undefined };
      return read(reading, positionOf(req, url), res, fail);
    };
    // Every await of the answer comes before its response's headers; a read fails after them in its stream.
    answer().catch((error: unknown) => {
      fail(error);
      res.writeHead(500).end();
    });
  };
}

// The recordings, oldest first: the `.jsonl` files in the directory, and the live one before its file exists.
async function recordings(dir: string, live: Recording) {
  return [...new Set((await readdir(dir)).filter((name) => name.endsWith(".jsonl"))).add(live.name)].sort();
}

function list(names: string[], live: Recording, res: ServerResponse) {
  const listed: Listing[] = names.map((name) => ({ name, live: name === live.name }));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(listed));
}

// [LAW:parse-dont-validate] The position read from: `Last-Event-ID` when an EventSource reconnects (it keeps
// the URL it first opened), else `?from=`, else the start. Anything but a decimal offset a file can have is
// no position, a repeated header too: node joins its values into one string (only set-cookie stays a list).
function positionOf(req: IncomingMessage, url: URL): number | undefined {
  const given = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("from") ?? "0";
  const position = Number(given);
  return /^\d+$/.test(given) && Number.isSafeInteger(position) ? position : undefined;
}

// One reader's read. `live` is the run's recording when that is the one read: it is followed, not ended.
type Reading = {
  log: Log;
  trace_id: string;
  ended: Promise<Ending>;
  name: string;
  path: string;
  live: Recording | undefined;
};

async function read(reading: Reading, position: number | undefined, res: ServerResponse, fail: (error: unknown) => void) {
  if (position === undefined || !(await atLineStart(reading, position))) {
    return void res.writeHead(400, { "content-type": "text/plain" }).end("from must be 0 or the id of an event\n");
  }
  // A request cut while its recording was looked up, by its client or its server's close, has ended and its
  // event is written: there is no one to read to. One still open has not ended, so the read's subscription
  // to `ended` comes in time.
  if (res.destroyed) return;
  // Flushed now, not with the first event: a reader of an empty live recording is connected before it has one.
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).flushHeaders();
  // pipeline destroys the stream when the response closes. Its callback runs after that close, when the
  // request's event is written, so it has nothing to add.
  pipeline(recordingEvents(reading, position, fail), res, () => {});
}

// A position is the start, or just past a newline in the file: the id of an event a reader was sent.
async function atLineStart(reading: Reading, position: number) {
  return position === 0 || (await bytesAt(reading, position - 1, 1))[0] === 0x0a;
}

// Up to `length` bytes of the recording from `position`. The writer's word: the live recording's bytes are
// the ones below `written`, and with none there may be no file. Each read opens the file and closes it
// before it returns, so a reader that leaves mid-read holds nothing open.
async function bytesAt({ path, live }: Reading, position: number, length: number) {
  const readable = Math.max(0, Math.min(length, (live?.written() ?? Infinity) - position));
  if (readable === 0) return Buffer.alloc(0);
  await using file = await open(path);
  const { bytesRead, buffer } = await file.read(Buffer.alloc(readable), 0, readable, position);
  return buffer.subarray(0, bytesRead);
}

// [LAW:no-ambient-temporal-coupling] The read is a stream piped into the response, so node owns backpressure
// and the response's close destroys it, which ends every wait it has: a file read, or the live recording's
// next event written. Lines are split on the raw newline byte, never decoded, so every id is an exact offset.
// [LAW:nothing-unseen] Catching up to the end of what exists is the reader's bounded work, and its own event
// in the request's trace, as an exchange's recording is: written when it first reaches the end, fails, or the
// request ends before then, with the request's ending. Following is the request itself; what it delivered is
// every event written after.
function recordingEvents(reading: Reading, from: number, fail: (error: unknown) => void) {
  const { log, trace_id, ended, name, live } = reading;
  const span = startSpan(trace_id);
  let offset = from; // just past the last line read into the stream
  let pending = Buffer.alloc(0); // the bytes after `offset` read so far: not yet a whole line
  let eventsRead = 0;
  let stopWaiting: (() => void) | undefined;
  let caughtUp = false;
  const catchUp = (ending: Ending) => {
    if (caughtUp) return;
    caughtUp = true;
    // events_read: read into the response stream; delivery past node's buffers is not knowable.
    log({ event: "catch_up", ...span.end(), ...ending, recording: name, live: live !== undefined, from, to: offset, events_read: eventsRead, unterminated_bytes: pending.length });
  };
  // [LAW:one-source-of-truth] Why a read cut short ended is the request's to say (the client left, or the
  // server was closed). Subscribed as the read starts, as the proxy subscribes an exchange's recorded `end`,
  // so a stop that cuts the read has this written before its `close` resolves.
  void ended.then(catchUp);

  const stream = new Readable({
    read: () => void fill(),
    destroy: (error, callback) => {
      stopWaiting?.();
      callback(error);
    },
  });

  const pushLines = (bytes: Buffer) => {
    const data = Buffer.concat([pending, bytes]);
    const events: Buffer[] = [];
    let start = 0;
    for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a, start)) {
      events.push(Buffer.from(`id: ${offset + end + 1}\ndata: `), data.subarray(start, end), Buffer.from("\n\n"));
      start = end + 1;
      eventsRead++;
    }
    offset += start;
    pending = data.subarray(start);
    // A line longer than what was read so far: read on.
    if (events.length === 0) return void fill();
    stream.push(Buffer.concat(events));
  };

  async function fill(): Promise<void> {
    try {
      const written = live?.written();
      const bytes = await bytesAt(reading, offset + pending.length, 64 * 1024);
      if (stream.destroyed) return;
      if (bytes.length > 0) return pushLines(bytes);
      // An event written during the read: not caught up to yet. Writes are synchronous on this
      // thread, so none can fall between this check and the subscription below.
      if (live?.written() !== written) return fill();
      catchUp({ outcome: "ok" });
      if (!live) {
        const end: RecordingEnd = { unterminated_bytes: pending.length };
        stream.push(`event: end\ndata: ${JSON.stringify(end)}\n\n`);
        return void stream.push(null);
      }
      stopWaiting = live.onWritten(() => {
        stopWaiting?.();
        stopWaiting = undefined;
        void fill();
      });
    } catch (error) {
      if (stream.destroyed) return;
      catchUp({ outcome: "error", error: describeError(error) });
      // The request's failure, on its event, written at the close the stream's end brings.
      fail(error);
      const failure: ReadFailure = { message: error instanceof Error ? error.message : String(error) };
      stream.push(`event: failed\ndata: ${JSON.stringify(failure)}\n\n`);
      stream.push(null);
    }
  }

  return stream;
}
