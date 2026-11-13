import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { serve, type Event } from "@cc-dump/log";
import { eventLog, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProxy } from "./proxy.ts";
import { createReader } from "./reading.ts";
import { parseReadFailure, type RecordedEvent } from "./format.ts";
import { createRecording, type Recording } from "./recording.ts";
import { proxyProcess } from "./testing.ts";

// A recordings directory, removed when the test finishes, with the run's recording in it.
function recordingsDir() {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-dump-")), "recordings");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const liveName = "20261113T080000.000Z.jsonl";

// The proxy recording to the live recording, an upstream that answers every request, and the reader.
async function proxyAndReader(dir = recordingsDir(), wrap = (recording: Recording) => recording) {
  const recording = wrap(createRecording(() => {}, join(dir, liveName)));
  const upstream = await serving((_req, res) => res.end("answer"));
  const proxy = await serving(createProxy(new URL(upstream.url), recording.record));
  const readerLog = eventLog();
  const reader = await serving(createReader(readerLog.log, recording));
  // One exchange through the proxy, waited on until its request event (and so its recording) is complete.
  const exchange = async (path: string) => {
    await buffer(await send(proxy.port, { path }));
    await proxy.next();
  };
  return { dir, recording, reader, readerLog, exchange, lines: () => linesOf(join(dir, liveName)) };
}

const linesOf = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

type ServerSentEvent = { id?: string; event?: string; data: string };

// A Server-Sent Events client: `next()` resolves with each event as it arrives.
async function subscribe(port: number, path: string, headers: Record<string, string> = {}) {
  const res = await send(port, { path, headers });
  const arrived: ServerSentEvent[] = [];
  const waiting: ((event: ServerSentEvent) => void)[] = [];
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    text += chunk;
    for (let at = text.indexOf("\n\n"); at !== -1; at = text.indexOf("\n\n")) {
      const fields = text
        .slice(0, at)
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]);
      text = text.slice(at + 2);
      const event = { data: "", ...Object.fromEntries(fields) } as ServerSentEvent;
      const waiter = waiting.shift();
      if (waiter) waiter(event);
      else arrived.push(event);
    }
  });
  const next = () => new Promise<ServerSentEvent>((resolve) => (arrived.length ? resolve(arrived.shift()!) : waiting.push(resolve)));
  const take = async (n: number) => {
    const events: ServerSentEvent[] = [];
    while (events.length < n) events.push(await next());
    return events;
  };
  return { res, next, take };
}

// What a reader should be sent for `lines`, starting at byte `from`: each line, its id the offset past it.
function expected(lines: string[], from = 0) {
  let offset = from;
  return lines.map((data) => ({ id: String((offset += Buffer.byteLength(data) + 1)), data }));
}

describe("createReader", () => {
  it("sends a reader that connects mid-session every event from the start, then each new one as it is written", async () => {
    const { reader, readerLog, exchange, lines } = await proxyAndReader();
    await exchange("/v1/models?n=1");
    const before = lines();

    const stream = await subscribe(reader.port, `/recordings/${liveName}`);
    expect(stream.res.headers["content-type"]).toBe("text/event-stream");
    expect(await stream.take(before.length)).toEqual(expected(before));
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", live: true, from: 0, events_read: before.length });

    await exchange("/v1/models?n=2");
    const after = lines().slice(before.length);
    expect(await stream.take(after.length)).toEqual(expected(after, Buffer.byteLength(before.join("\n") + "\n")));
    stream.res.destroy();
  });

  it("sends a finished recording's events, then its end, and ends", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, "20261101T000000.000Z.jsonl"), '{"a":1}\n{"b":"é"}\n');
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, "/recordings/20261101T000000.000Z.jsonl");
    const ended = once(stream.res, "end");

    expect(await stream.take(3)).toEqual([...expected(['{"a":1}', '{"b":"é"}']), { event: "end", data: '{"unterminated_bytes":0}' }]);
    await ended;
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", live: false, events_read: 2 });
  });

  it("serves a recording cut mid-line by a crash up to its last whole line, counting the cut bytes", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, "20261101T000000.000Z.jsonl"), '{"a":1}\n{"b":');
    const { reader } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, "/recordings/20261101T000000.000Z.jsonl");

    expect(await stream.take(2)).toEqual([...expected(['{"a":1}']), { event: "end", data: '{"unterminated_bytes":5}' }]);
  });

  it.each([
    ["Last-Event-ID", (id: string) => ({ path: "", headers: { "last-event-id": id } })],
    ["?from=", (id: string) => ({ path: `?from=${id}`, headers: {} })],
  ])("resumes from an event's id named by %s, sending only the events after it", async (_how, given) => {
    const { reader, exchange, lines } = await proxyAndReader();
    await exchange("/v1/models");
    const all = expected(lines());
    const { path, headers } = given(all[1]!.id);

    const stream = await subscribe(reader.port, `/recordings/${liveName}${path}`, headers);

    expect(await stream.take(all.length - 2)).toEqual(all.slice(2));
    stream.res.destroy();
  });

  it.each(["1", "999999", "99999999999999999999", "x"])("refuses %s, which is not the id of an event, with 400", async (from) => {
    const { reader, exchange } = await proxyAndReader();
    await exchange("/v1/models");

    const res = await send(reader.port, { path: `/recordings/${liveName}?from=${from}` });
    await buffer(res);

    expect(res.statusCode).toBe(400);
  });

  // The live recording spelled in lower case: a case-insensitive filesystem would open it.
  it.each(["20200101T000000.000Z.jsonl", "..%2F..%2Fsecret.jsonl", "notes.txt", liveName.toLowerCase()])("answers 404 for %s, which is not a recording", async (name) => {
    const { reader, exchange } = await proxyAndReader();
    await exchange("/v1/models");

    const res = await send(reader.port, { path: `/recordings/${name}` });
    await buffer(res);

    expect(res.statusCode).toBe(404);
  });

  it("lists past recordings and the live one, oldest first, the live one before its first event", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, "20261101T000000.000Z.jsonl"), "");
    const { reader } = await proxyAndReader(dir);

    const res = await send(reader.port, { path: "/recordings" });

    expect(JSON.parse((await buffer(res)).toString())).toEqual([
      { name: "20261101T000000.000Z.jsonl", live: false },
      { name: liveName, live: true },
    ]);
  });

  it("follows the live recording from before its first event", async () => {
    const { reader, readerLog, exchange, lines } = await proxyAndReader();

    const stream = await subscribe(reader.port, `/recordings/${liveName}`);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", from: 0, to: 0, events_read: 0 });
    await exchange("/v1/models");

    expect(await stream.take(lines().length)).toEqual(expected(lines()));
    stream.res.destroy();
  });

  it("stops waiting for writes when a reader of the live recording leaves", async () => {
    let waiting = 0;
    const counted = (recording: Recording): Recording => ({
      ...recording,
      onWritten: (listener) => {
        waiting++;
        const stop = recording.onWritten(listener);
        return () => {
          waiting--;
          stop();
        };
      },
    });
    const { reader, readerLog } = await proxyAndReader(undefined, counted);

    const stream = await subscribe(reader.port, `/recordings/${liveName}`);
    await readerLog.next();
    expect(waiting).toBe(1);
    stream.res.destroy();

    expect(await reader.next()).toMatchObject({ event: "request", outcome: "aborted" });
    expect(waiting).toBe(0);
  });

  it("logs a reader that leaves mid-catch-up, held by backpressure, as aborted with what it was read", async () => {
    const dir = recordingsDir();
    const line = JSON.stringify({ data: "x".repeat(1000) });
    writeFileSync(join(dir, "20261101T000000.000Z.jsonl"), `${line}\n`.repeat(20_000));
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, "/recordings/20261101T000000.000Z.jsonl");
    await stream.next();
    stream.res.pause();
    stream.res.destroy();

    const caughtUp = await readerLog.next();
    expect(caughtUp).toMatchObject({ event: "catch_up", outcome: "aborted" });
    expect(caughtUp.events_read).toBeGreaterThan(0);
    expect(caughtUp.events_read).toBeLessThan(20_000);
  });

  it("logs a reader its server stopped mid-catch-up, held by backpressure, as stopped on its catch_up and its request", async () => {
    const dir = recordingsDir();
    const line = JSON.stringify({ data: "x".repeat(1000) });
    writeFileSync(join(dir, "20261101T000000.000Z.jsonl"), `${line}\n`.repeat(20_000));
    const { log, next } = eventLog();
    const reader = await serve(log, createReader(log, createRecording(() => {}, join(dir, liveName))), 0);
    await next();

    const stream = await subscribe(reader.port, "/recordings/20261101T000000.000Z.jsonl");
    await stream.next();
    stream.res.pause();
    const closed = reader.close();
    await expect(buffer(stream.res)).rejects.toThrow(/aborted/);
    await closed;

    const [request, caughtUp, close] = [await next(), await next(), await next()];
    expect(request).toMatchObject({ event: "request", outcome: "stopped", status: 200 });
    expect(caughtUp).toMatchObject({ event: "catch_up", trace_id: request.trace_id, outcome: "stopped" });
    expect(caughtUp.events_read).toBeGreaterThan(0);
    expect(caughtUp.events_read).toBeLessThan(20_000);
    expect(close).toMatchObject({ event: "close", outcome: "ok", requests_open: 1 });
  });

  it("starts no read for a reader its server stopped while the recording was looked up, so its events all come before the close", async () => {
    const recording = createRecording(() => {}, join(recordingsDir(), liveName));
    const { promise: listed, resolve: list } = Promise.withResolvers<void>();
    // The reader reads the live recording's name once the directory is listed.
    const watched = Object.defineProperty({ ...recording }, "name", { get: () => (list(), recording.name) });
    const logged: Event[] = [];
    const log = (event: Event) => void logged.push(event);
    const handle = createReader(log, watched);
    let closed: Promise<void> | undefined;
    const reader = await serve(
      log,
      (req, res, work) => {
        handle(req, res, work);
        closed = reader.close();
      },
      0,
    );

    await expect(send(reader.port, { path: `/recordings/${liveName}` })).rejects.toThrow(/socket hang up/);
    await closed;
    await listed;
    await setImmediate();

    expect(logged.map(({ event, outcome }) => [event, outcome])).toEqual([
      ["listen", "ok"],
      ["request", "stopped"],
      ["close", "ok"],
    ]);
  });

  it("sends each event written whole after a write that failed part-way as its own event", async () => {
    const dir = recordingsDir();
    const path = join(dir, liveName);
    const upstream = await serving((_req, res) => res.end("answer"));
    // A file size limit of 8 blocks: 4096 or 8192 bytes, as the shell counts them. The exchange's first
    // event, its request, is over 10 KB: POSIX has a write with less room than it asks for write what fits,
    // so writing it writes up to the limit, and carrying on fails with EFBIG. Its later
    // events are small enough to fit below the limit.
    const { proxyPort, readerPort } = await proxyProcess(upstream.url, path, "8");

    const stream = await subscribe(readerPort, `/recordings/${liveName}`);
    await buffer(await send(proxyPort, { path: `/v1/models?pad=${"x".repeat(10_000)}` }));
    const sent: ServerSentEvent[] = [];
    do sent.push(await stream.next());
    while ((JSON.parse(sent.at(-1)!.data) as RecordedEvent).type !== "end");
    stream.res.destroy();

    // The file ends at its last whole event: the next write cut away the part of the request's line.
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(sent).toEqual(expected(lines));
    expect(lines.map((line) => (JSON.parse(line) as RecordedEvent).type)).toEqual(["request_trailers", "response", "response_body", "response_trailers", "end"]);
  });

  it("makes a read error after the response started the request's error, and ends the stream with a failed event", async () => {
    const dir = recordingsDir();
    // The live recording is a directory: it opens, and reading it fails with EISDIR.
    mkdirSync(join(dir, liveName));
    const listeners = new Set<() => void>();
    let written = 0;
    const broken: Recording = {
      name: liveName,
      path: join(dir, liveName),
      record: () => () => {},
      written: () => written,
      onWritten: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    };
    const readerLog = eventLog();
    const reader = await serving(createReader(readerLog.log, broken));

    const stream = await subscribe(reader.port, `/recordings/${liveName}`);
    const ended = once(stream.res, "end");
    await readerLog.next();
    written = 1;
    for (const listener of listeners) listener();

    const failed = await stream.next();
    await ended;
    expect(failed).toEqual({ event: "failed", data: expect.any(String) });
    const { message } = parseReadFailure(failed.data);
    expect(message).toMatch(/^EISDIR/);
    expect(await reader.next()).toMatchObject({ event: "request", outcome: "error", error: expect.stringContaining(message), status: 200 });
  });
});
