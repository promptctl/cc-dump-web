import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import { failed, startSpan, unitOfWork, type Ending, type Log, type TraceId } from "@cc-dump/log";
import { json, Refused, stream, type Route } from "@cc-dump/log/answer";
import { describe } from "@cc-dump/log/describe";
import { frame, READ_ENDED, READ_FAILED, type Failure } from "@cc-dump/log/wire";
import { offsetOf, type Listing, type RecordingEnd } from "./format.ts";
import { recordedLength, splitLines } from "./recording.ts";
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
export function createReader(log: Log, recordings: Recordings): { list: Route; read: Route } {
  const { dir } = recordings;
  return {
    list: async () => json((await nonEmpty(dir, await files(dir))).map((name): Listing => ({ name }))),
    read: async (req, { trace_id, fail, ended }, { params, query }) => {
      const name = await readableName(recordings, params.name);
      if (!name) throw new Refused(404, `${params.name} is no recording this proxy lists or follows`);
      const reading = readingOf(log, recordings, trace_id, ended, name);
      const position = positionOf(req.headers["last-event-id"], query);
      if (position === undefined || !(await atLineStart(reading, position))) throw new Refused(400, "from must be 0 or the id of an event");
      // Every await of the answer comes before its response's headers; a read fails after them in its stream.
      // pipeline destroys the stream when the response closes. Its callback runs after that close, when the request's
      // event is written, so it has nothing to add.
      return stream((res) => void pipeline(recordingEvents(reading, position, fail), res, () => {}));
    },
  };
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

// [LAW:parse-dont-validate] [LAW:single-enforcer] The name that may be read, or none: a file the directory lists,
// spelled as it lists it, or a recording the run holds a writer for, by the name it was given. Nothing else in the URL
// reaches the filesystem, and a case-insensitive filesystem cannot open the run's recording by another spelling and
// serve it as finished. The run's own is known in memory, so the directory is listed only for a name it does not hold.
// A name that is neither, a typo or one nothing made, is not waited on.
async function readableName(recordings: Recordings, asked: string | undefined): Promise<ReadableName | undefined> {
  if (asked === undefined) return undefined;
  return recordings.follows(asked) || (await files(recordings.dir)).includes(asked) ? (asked as ReadableName) : undefined;
}

declare const listedOrFollowed: unique symbol;
// [LAW:types-are-the-program] A name `readableName` let through, the only name a read joins to the recordings directory.
type ReadableName = string & { readonly [listedOrFollowed]: true };

// [LAW:parse-dont-validate] The position read from: `Last-Event-ID` when an EventSource reconnects (it keeps
// the URL it first opened), else `?from=`, else the start. Anything but a decimal offset a file can have is
// no position, a repeated header too: node joins its values into one string (only set-cookie stays a list).
function positionOf(lastEventId: string | string[] | undefined, query: URLSearchParams): number | undefined {
  const given = (lastEventId as string | undefined) ?? query.get("from") ?? "0";
  return offsetOf(given);
}

// One reader's read of the recording `name`, which is followed, not ended, when `followed`.
// [LAW:one-source-of-truth] `limit()`: how many bytes of it may be read now, the one source of that for the whole read.
// A recording no writer holds is finished, so its limit is measured once, when the read first asks, and only a followed
// read asks its writer's `written` each time. `unterminated()`: the bytes after its last newline, never sent.
type Reading = {
  log: Log;
  trace_id: TraceId;
  ended: Promise<Ending>;
  name: ReadableName;
  path: string;
  followed: boolean;
  recordings: Recordings;
  limit: () => number;
  unterminated: () => number;
};

function readingOf(log: Log, recordings: Recordings, trace_id: TraceId, ended: Promise<Ending>, name: ReadableName): Reading {
  const path = join(recordings.dir, name);
  const followed = recordings.follows(name);
  // [LAW:no-silent-failure] A finished recording is listed by its file, so a file that is gone fails the read, not ends it
  // empty; the run's own, followed, has none until its first write, and nothing of it is cut.
  let finished: NonNullable<ReturnType<typeof recordedLength>> | undefined;
  const measured = () => (finished ??= recordedLength(path) ?? gone(name));
  return {
    log,
    trace_id,
    ended,
    name,
    path,
    followed,
    recordings,
    limit: followed ? () => recordings.readable(name) : () => measured().terminated,
    unterminated: followed ? () => recordedLength(path)?.unterminated ?? 0 : () => measured().unterminated,
  };
}

function gone(name: string): never {
  throw new Error(`recording ${name} is gone`);
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
// and the response's close destroys it, which stops its wait for the followed recording's next event written; a file
// read under way runs on, and what it read is dropped when it finds the stream destroyed. Lines are split on the raw newline byte, never decoded, so every id is an exact offset.
// [LAW:nothing-unseen] Catching up to the end of what exists is the reader's bounded work, and its own event
// in the request's trace, as an exchange's recording is: written when it first reaches the end, fails, or the
// request ends before then, with the request's ending. Following is the request itself; what it delivered is
// every event written after.
function recordingEvents(reading: Reading, from: number, fail: (error: unknown) => void) {
  const { log, trace_id, ended, name, followed, recordings } = reading;
  const span = startSpan(trace_id);
  let offset = from; // just past the last line read into the stream
  let pending: Buffer = Buffer.alloc(0); // the bytes after `offset` read so far: not yet a whole line
  let eventsRead = 0;
  let stopWaiting: (() => void) | undefined;
  // The catch-up ends at the first of: the read reaching the end, failing, or the request ending.
  const catchUp = unitOfWork(log, "catch_up", { recording: name, followed, from }, span);
  // events_read: read into the response stream; delivery past node's buffers is not knowable.
  const read = () => ({ to: offset, events_read: eventsRead });
  // [LAW:one-source-of-truth] Why a read cut short ended is the request's to say (the client left, or the
  // server was closed). Subscribed as the read starts, as the proxy subscribes an exchange's recorded `end`,
  // so a stop that cuts the read has this written before its `close` resolves.
  void ended.then((ending) => catchUp.end(ending, read));

  const readable = new Readable({
    read: () => void fill(),
    destroy: (error, callback) => {
      stopWaiting?.();
      callback(error);
    },
  });

  const pushLines = (bytes: Buffer) => {
    const data = Buffer.concat([pending, bytes]);
    const { lines, rest } = splitLines(data, offset);
    const events = lines.map(({ line, end }) => frame({ id: String(end), data: line.toString() })).join("");
    eventsRead += lines.length;
    offset += data.length - rest.length;
    pending = rest;
    // A line longer than what was read so far: read on.
    if (events === "") return void fill();
    readable.push(events);
  };

  async function fill(): Promise<void> {
    try {
      const limit = reading.limit();
      const bytes = await bytesAt(reading, offset + pending.length, 64 * 1024, limit);
      if (readable.destroyed) return;
      if (bytes.length > 0) return pushLines(bytes);
      // An event written during the read: not caught up to yet. Writes are synchronous on this
      // thread, so none can fall between this check and the subscription below.
      if (reading.limit() !== limit) return fill();
      if (!followed) {
        // [LAW:one-source-of-truth] What a finished recording ends with is what `recordedLength` finds after its last
        // newline, the measure that bounded the read.
        const end: RecordingEnd = { unterminated_bytes: reading.unterminated() };
        catchUp.end({ outcome: "ok" }, () => ({ ...read(), ...end }));
        readable.push(frame({ event: READ_ENDED, data: JSON.stringify(end) }));
        return void readable.push(null);
      }
      // A followed read arrives at the end after every event written; only its first arrival ends the catch-up, so
      // only that one measures the recording's end.
      catchUp.end({ outcome: "ok" }, () => ({ ...read(), unterminated_bytes: reading.unterminated() }));
      stopWaiting = recordings.onWritten((written) => {
        if (written !== name) return;
        stopWaiting?.();
        stopWaiting = undefined;
        void fill();
      });
    } catch (error) {
      if (readable.destroyed) return;
      catchUp.end(failed(error), read);
      // The request's failure, on its event, written at the close the stream's end brings.
      fail(error);
      // The `failed` event's data is a `Failure`, as a refusal's body is: the error's words, which the request's event has
      // with its stack.
      const failure: Failure = { error: describe(error) };
      readable.push(frame({ event: READ_FAILED, data: JSON.stringify(failure) }));
      readable.push(null);
    }
  }

  return readable;
}
