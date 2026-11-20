import { readdir, open, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import { describeError, startSpan, type Ending, type Handler, type Log } from "@cc-dump/log";
import type { TraceId } from "@cc-dump/log/trace";
import type { Listing, ReadFailure, RecordingEnd } from "./format.ts";
import { recordedLength } from "./recording.ts";
import type { Recordings } from "./recordings.ts";

// [LAW:decomposition] The recordings' read side, and the one path traffic takes to the screen
// (docs/design/01-features.md): live viewing, reopening, refresh and reload are all one read from a position.
// `GET /recordings` lists the `.jsonl` files of the recordings directory that hold something, in no order of its own: a
// recording with no bytes has no conversation, and one a launch made is opened by its name. `GET /recordings/<name>` is
// Server-Sent Events, one per recorded line, whose id is the byte offset just past the line: a reconnecting EventSource
// resumes from it with `Last-Event-ID`. A recording the proxy run is writing (`Recordings.follows`) is read to its end
// and then on, as it is written, until the reader leaves; any other is finished, and ends with an `end` event. A read
// that fails once begun ends with a `failed` event: the stream's only way to tell a reader it failed, since an
// EventSource takes a cut stream for a dropped connection and reconnects into the same failure.
// A reader never creates a recording: only a name with a file, or one the run is writing, is read, and any other is 404.
export function createReader(log: Log, recordings: Recordings): Handler {
  const { dir } = recordings;
  return (req, res, { trace_id, fail, ended }) => {
    const url = new URL(req.url!, "http://reader");
    const asked = nameIn(url.pathname);
    const answer = async () => {
      if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
      if (url.pathname === "/recordings") return list(await nonEmpty(dir, await files(dir)), res);
      const name = await readableName(recordings, asked);
      if (!name) return void res.writeHead(404).end();
      return read(readingOf(log, recordings, trace_id, ended, name), positionOf(req, url), res, fail);
    };
    // Every await of the answer comes before its response's headers; a read fails after them in its stream.
    answer().catch((error: unknown) => {
      fail(error);
      res.writeHead(500).end();
    });
  };
}

// [LAW:parse-dont-validate] The name a URL's path asks for, as the file system spells it: the path's segment is
// percent-encoded, and one with a malformed escape names nothing.
function nameIn(pathname: string): string | undefined {
  const segment = /^\/recordings\/([^/]+)$/.exec(pathname)?.[1];
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

// The recordings: the `.jsonl` files in the directory.
async function files(dir: string) {
  return (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
}

// Those of `names` whose file holds bytes. One that went between the listing and the look is not listed.
async function nonEmpty(dir: string, names: string[]) {
  const sizes = await Promise.all(names.map((name) => stat(join(dir, name)).then(({ size }) => size, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? 0 : Promise.reject(error)))));
  return names.filter((_, index) => sizes[index]! > 0);
}

function list(names: string[], res: ServerResponse) {
  const listed: Listing[] = names.map((name) => ({ name }));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(listed));
}

// [LAW:parse-dont-validate] [LAW:single-enforcer] The name that may be read, or none: a file the directory lists,
// spelled as it lists it, or a recording the run holds a writer for, by the name it was given. Nothing else in the URL
// reaches the filesystem, and a case-insensitive filesystem cannot open the run's recording by another spelling and
// serve it as finished. The run's own is known in memory, so the directory is listed only for a name it does not hold.
// A name that is neither, a typo or one nothing made, is not waited on.
async function readableName(recordings: Recordings, asked: string | undefined): Promise<ReadableName | undefined> {
  if (asked === undefined) return undefined;
  if (recordings.follows(asked)) return asked as ReadableName;
  return (await files(recordings.dir)).find((name) => name === asked) as ReadableName | undefined;
}

declare const readable: unique symbol;
// A name `readableName` found, so the one a read may join to the directory.
type ReadableName = string & { readonly [readable]: true };

// [LAW:parse-dont-validate] The position read from: `Last-Event-ID` when an EventSource reconnects (it keeps
// the URL it first opened), else `?from=`, else the start. Anything but a decimal offset a file can have is
// no position, a repeated header too: node joins its values into one string (only set-cookie stays a list).
function positionOf(req: IncomingMessage, url: URL): number | undefined {
  const given = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("from") ?? "0";
  const position = Number(given);
  return /^\d+$/.test(given) && Number.isSafeInteger(position) ? position : undefined;
}

// One reader's read of the recording `name`, which is followed, not ended, when `followed`.
// [LAW:one-source-of-truth] `limit()`: how many bytes of it may be read now, the one source of that for the whole read.
// A recording no writer holds is finished, so its limit is measured once, when the read first asks, and only a followed
// read asks its writer's `written` each time. `unterminated()`: the bytes after its last newline, never sent.
type Reading = {
  log: Log;
  trace_id: TraceId;
  ended: Promise<Ending>;
  name: string;
  path: string;
  followed: boolean;
  recordings: Recordings;
  limit: () => number;
  unterminated: () => number;
};

function readingOf(log: Log, recordings: Recordings, trace_id: TraceId, ended: Promise<Ending>, name: ReadableName): Reading {
  const path = join(recordings.dir, name);
  const followed = recordings.follows(name);
  let finished: ReturnType<typeof recordedLength> | undefined;
  const measured = () => (finished ??= recordedLength(path));
  return {
    log,
    trace_id,
    ended,
    name,
    path,
    followed,
    recordings,
    limit: followed ? () => recordings.readable(name) : () => measured().terminated,
    unterminated: followed ? () => recordedLength(path).unterminated : () => measured().unterminated,
  };
}

async function read(reading: Reading, position: number | undefined, res: ServerResponse, fail: (error: unknown) => void) {
  if (position === undefined || !(await atLineStart(reading, position))) {
    return void res.writeHead(400, { "content-type": "text/plain" }).end("from must be 0 or the id of an event\n");
  }
  // A request cut while its recording was looked up, by its client or its server's close, has ended and its
  // event is written: there is no one to read to. One still open has not ended, so the read's subscription
  // to `ended` comes in time.
  if (res.destroyed) return;
  // Flushed now, not with the first event: a reader of an empty followed recording is connected before it has one.
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).flushHeaders();
  // pipeline destroys the stream when the response closes. Its callback runs after that close, when the
  // request's event is written, so it has nothing to add.
  pipeline(recordingEvents(reading, position, fail), res, () => {});
}

// A position is the start, or just past a newline in the file: the id of an event a reader was sent.
async function atLineStart(reading: Reading, position: number) {
  return position === 0 || (await bytesAt(reading, position - 1, 1, reading.limit()))[0] === 0x0a;
}

// Up to `length` bytes of the recording from `position`, of the first `limit` bytes, which are whole events; with none
// there may be no file. Each read opens the file and closes it before it returns, so a
// reader that leaves mid-read holds nothing open.
async function bytesAt({ path }: Reading, position: number, length: number, limit: number) {
  const readable = Math.max(0, Math.min(length, limit - position));
  if (readable === 0) return Buffer.alloc(0);
  await using file = await open(path);
  const { bytesRead, buffer } = await file.read(Buffer.alloc(readable), 0, readable, position);
  return buffer.subarray(0, bytesRead);
}

// [LAW:no-ambient-temporal-coupling] The read is a stream piped into the response, so node owns backpressure
// and the response's close destroys it, which ends every wait it has: a file read, or the followed recording's
// next event written. Lines are split on the raw newline byte, never decoded, so every id is an exact offset.
// [LAW:nothing-unseen] Catching up to the end of what exists is the reader's bounded work, and its own event
// in the request's trace, as an exchange's recording is: written when it first reaches the end, fails, or the
// request ends before then, with the request's ending. Following is the request itself; what it delivered is
// every event written after.
function recordingEvents(reading: Reading, from: number, fail: (error: unknown) => void) {
  const { log, trace_id, ended, name, followed, recordings } = reading;
  const span = startSpan(trace_id);
  let offset = from; // just past the last line read into the stream
  let pending = Buffer.alloc(0); // the bytes after `offset` read so far: not yet a whole line
  let eventsRead = 0;
  let stopWaiting: (() => void) | undefined;
  let caughtUp = false;
  // unterminated_bytes: the recording's, which only a read that reached its end has measured; absent otherwise.
  const catchUp = (ending: Ending, unterminated_bytes?: number) => {
    if (caughtUp) return;
    caughtUp = true;
    // events_read: read into the response stream; delivery past node's buffers is not knowable.
    log({ event: "catch_up", ...span.end(), ...ending, recording: name, followed, from, to: offset, events_read: eventsRead, unterminated_bytes });
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
      const limit = reading.limit();
      const bytes = await bytesAt(reading, offset + pending.length, 64 * 1024, limit);
      if (stream.destroyed) return;
      if (bytes.length > 0) return pushLines(bytes);
      // An event written during the read: not caught up to yet. Writes are synchronous on this
      // thread, so none can fall between this check and the subscription below.
      if (reading.limit() !== limit) return fill();
      if (!followed) {
        // [LAW:one-source-of-truth] What a finished recording ends with is what `recordedLength` finds after its last
        // newline, the measure that bounded the read.
        const end: RecordingEnd = { unterminated_bytes: reading.unterminated() };
        catchUp({ outcome: "ok" }, end.unterminated_bytes);
        stream.push(`event: end\ndata: ${JSON.stringify(end)}\n\n`);
        return void stream.push(null);
      }
      // Measured by the first arrival at the end only: a followed read arrives at it after every event written.
      if (!caughtUp) catchUp({ outcome: "ok" }, reading.unterminated());
      stopWaiting = recordings.onWritten((written) => {
        if (written !== name) return;
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
