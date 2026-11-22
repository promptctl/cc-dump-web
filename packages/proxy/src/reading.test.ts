import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { serve, type Log } from "@cc-dump/log";
import { routes } from "@cc-dump/log/answer";
import { eventLog, eventsWritten, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProxy, parseUpstream } from "./proxy.ts";
import { createReader } from "./reading.ts";
import { agentBaseUrl, parseListing, parseListings, recordingName, type RecordedEvent } from "./format.ts";
import { createRecordings, type Recordings } from "./recordings.ts";
import { proxyProcess, runName } from "./testing.ts";
import { subscribe } from "@cc-dump/log/testing";
import { parseFailure, ROUTES, type ServerSentEvent } from "@cc-dump/log/wire";

// A recordings directory, removed when the test finishes.
function recordingsDir() {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-dump-")), "recordings");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A Claude Code process's recording, and one a past run of the proxy left.
const agentName = recordingName(new Date("2026-11-13T08:00:00.000Z"));
const pastRun = "run-20261101T000000.000Z.jsonl";

// The reader's routes, as the reader port serves them.
function readerOver(log: Log, recordings: Recordings) {
  const { list, read } = createReader(log, recordings);
  return routes({ [ROUTES.recordings]: { GET: list }, [ROUTES.recording]: { GET: read } });
}

// The proxy recording into the directory, an upstream that answers every request, and the reader. `recordings.create()`
// makes `agentName`, the moment the proxy's clock stands at.
async function proxyAndReader(dir = recordingsDir(), wrap = (recordings: Recordings) => recordings) {
  const recordings = wrap(createRecordings(() => {}, dir, runName, () => new Date("2026-11-13T08:00:00.000Z")));
  const upstream = await serving((_req, res) => res.end("answer"));
  const proxy = await serving(createProxy(parseUpstream(upstream.url), recordings));
  const readerLog = eventLog();
  const reader = await serving(readerOver(readerLog.log, recordings));
  // One exchange through the proxy, as the agent `agentName` makes it unless `agent` is null, waited on until its request
  // event (and so its recording) is complete.
  const exchange = async (path: string, agent: string | null = agentName) => {
    await buffer(await send(proxy.port, { path: `${agent === null ? "" : agentBaseUrl("", agent)}${path}` }));
    await proxy.next();
  };
  return { dir, recordings, reader, readerLog, exchange, lines: (name = agentName) => linesOf(join(dir, name)) };
}

const linesOf = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

// What a reader should be sent for `lines`, starting at byte `from`: each line, its id the offset past it.
function expected(lines: string[], from = 0) {
  let offset = from;
  return lines.map((data) => ({ id: String((offset += Buffer.byteLength(data) + 1)), event: "message", data }));
}

describe("createReader", () => {
  it("sends a reader that connects mid-session every event from the start, then each new one as it is written", async () => {
    const { reader, readerLog, exchange, lines } = await proxyAndReader();
    await exchange("/v1/models?n=1");
    const before = lines();

    const stream = await subscribe(reader.port, `/recordings/${agentName}`);
    expect(stream.res.headers["content-type"]).toBe("text/event-stream");
    expect(await stream.take(before.length)).toEqual(expected(before));
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", followed: true, from: 0, events_read: before.length });

    await exchange("/v1/models?n=2");
    const after = lines().slice(before.length);
    expect(await stream.take(after.length)).toEqual(expected(after, Buffer.byteLength(before.join("\n") + "\n")));
    stream.res.destroy();
  });

  it("sends a past run's recording's events, then its end, and ends", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, pastRun), '{"a":1}\n{"b":"é"}\n');
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);
    const ended = once(stream.res, "end");

    expect(await stream.take(3)).toEqual([...expected(['{"a":1}', '{"b":"é"}']), { event: "end", data: '{"unterminated_bytes":0}' }]);
    await ended;
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", followed: false, events_read: 2 });
  });

  it("serves a recording cut mid-line by a crash up to its last whole line, counting the cut bytes", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, pastRun), '{"a":1}\n{"b":');
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);

    expect(await stream.take(2)).toEqual([...expected(['{"a":1}']), { event: "end", data: '{"unterminated_bytes":5}' }]);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", followed: false, to: 8, unterminated_bytes: 5 });
  });

  it("ends an agent's recording this run holds no writer for, as finished, until a request continues it", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, agentName), '{"a":1}\n{"b":');
    const { reader, readerLog, exchange } = await proxyAndReader(dir);

    const finished = await subscribe(reader.port, `/recordings/${agentName}`);
    expect(await finished.take(2)).toEqual([...expected(['{"a":1}']), { event: "end", data: '{"unterminated_bytes":5}' }]);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", followed: false });

    // The agent outlived the proxy's restart and goes on: its recording is continued after its last whole line, and is
    // this run's to follow from then on, so only whole events are sent.
    await exchange("/v1/models");
    const lines = linesOf(join(dir, agentName));
    const stream = await subscribe(reader.port, `/recordings/${agentName}`, { "last-event-id": String(Buffer.byteLength('{"a":1}\n')) });
    const sent = await stream.take(lines.length - 1);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", followed: true, unterminated_bytes: 0 });
    stream.res.destroy();

    expect(lines[0]).toBe('{"a":1}');
    expect(readFileSync(join(dir, agentName), "utf8")).not.toContain('{"b":');
    expect(sent).toEqual(expected(lines.slice(1), Buffer.byteLength('{"a":1}\n')));
    expect(sent.map(({ data }) => (JSON.parse(data) as RecordedEvent).type)).toEqual(["request", "request_trailers", "response", "response_body", "response_trailers", "end"]);
  });

  it("counts the bytes after the last whole line of a recording it follows in its catch_up, as it does of one it does not", async () => {
    const { dir, reader, readerLog, recordings } = await proxyAndReader();
    const name = recordings.create();
    // What a write that failed left past the writer's last whole event.
    writeFileSync(join(dir, name), '{"a":1}\n{"b":');

    const stream = await subscribe(reader.port, `/recordings/${name}`);

    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", followed: true, unterminated_bytes: 5 });
    stream.res.destroy();
  });

  it("measures a recording no writer holds once, and reads no further than it measured while the file grows", async () => {
    const dir = recordingsDir();
    const line = `${JSON.stringify({ data: "x".repeat(1000) })}\n`;
    writeFileSync(join(dir, pastRun), line.repeat(500));
    const { reader } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);
    await stream.next();
    appendFileSync(join(dir, pastRun), line.repeat(50));
    const events = [];
    do events.push(await stream.next());
    while (events.at(-1)!.event !== "end");

    expect(events.length).toBe(499 + 1);
  });

  it.each([
    ["Last-Event-ID", (id: string) => ({ path: "", headers: { "last-event-id": id } })],
    ["?from=", (id: string) => ({ path: `?from=${id}`, headers: {} })],
  ])("resumes from an event's id named by %s, sending only the events after it", async (_how, given) => {
    const { reader, exchange, lines } = await proxyAndReader();
    await exchange("/v1/models");
    const all = expected(lines());
    const { path, headers } = given(all[1]!.id);

    const stream = await subscribe(reader.port, `/recordings/${agentName}${path}`, headers);

    expect(await stream.take(all.length - 2)).toEqual(all.slice(2));
    stream.res.destroy();
  });

  it.each(["1", "999999", "99999999999999999999", "x"])("refuses %s, which is not the id of an event, with 400", async (from) => {
    const { reader, exchange } = await proxyAndReader();
    await exchange("/v1/models");

    const res = await send(reader.port, { path: `/recordings/${agentName}?from=${from}` });
    await buffer(res);

    expect(res.statusCode).toBe(400);
  });

  // The run's recording spelled in lower case: a case-insensitive filesystem would open it. An agent's name that no
  // file has and no writer holds is a typo or a stale name, which is not waited on for ever.
  it.each(["run-20200101T000000.000Z.jsonl", "..%2F..%2Fsecret.jsonl", "notes.txt", "notes.jsonl", runName.toLowerCase(), agentName.toLowerCase(), agentName])(
    "answers 404 for %s, which is not a recording",
    async (name) => {
      const { reader, exchange } = await proxyAndReader();
      await exchange("/v1/models", null);

      const res = await send(reader.port, { path: `/recordings/${name}` });
      await buffer(res);

      expect(res.statusCode).toBe(404);
    },
  );

  it("lists the `.jsonl` files of the directory that hold something, whatever they are named, in no order of its own", async () => {
    const dir = recordingsDir();
    for (const name of [agentName, pastRun, "notes.jsonl", "notes.txt"]) writeFileSync(join(dir, name), '{"a":1}\n');
    writeFileSync(join(dir, "empty.jsonl"), "");
    const { reader } = await proxyAndReader(dir);

    const res = await send(reader.port, { path: "/recordings" });

    expect(parseListings((await buffer(res)).toString()).map(({ name }) => name).sort()).toEqual([agentName, "notes.jsonl", pastRun]);
  });

  it("opens an empty recording by its name, though the list leaves it out", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, pastRun), "");
    const { reader } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);

    expect(await stream.next()).toEqual({ event: "end", data: '{"unterminated_bytes":0}' });
  });

  it("opens a recording whose name the URL spells with escapes, and answers 404 for an escape that is malformed", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, "my session.jsonl"), '{"a":1}\n');
    const { reader } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${encodeURIComponent("my session.jsonl")}`);
    expect(await stream.take(2)).toEqual([...expected(['{"a":1}']), { event: "end", data: '{"unterminated_bytes":0}' }]);

    for (const path of ["/recordings/my%20session.jsonl", "/recordings/my%zzsession.jsonl", "/recordings/%E0%A4%A.jsonl"]) {
      const res = await send(reader.port, { path });
      await buffer(res);
      expect(res.statusCode).toBe(path === "/recordings/my%20session.jsonl" ? 200 : 404);
    }
  });

  it("follows a recording the run made for a new agent, empty until its process writes, and sends its events once it does", async () => {
    const { dir, recordings, reader, readerLog, exchange, lines } = await proxyAndReader();
    expect(recordings.create()).toBe(agentName);

    const stream = await subscribe(reader.port, `/recordings/${agentName}`);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "ok", followed: true, from: 0, to: 0, events_read: 0 });
    expect(readdirSync(dir)).toEqual([agentName]);
    // Nothing is in it yet, so it has no conversation to list.
    expect(JSON.parse((await buffer(await send(reader.port, { path: "/recordings" }))).toString())).toEqual([]);

    await exchange("/v1/models");

    expect(await stream.take(lines().length)).toEqual(expected(lines()));
    stream.res.destroy();
  });

  it("follows the run's own recording, which holds the traffic no agent claims", async () => {
    const { reader, exchange, lines } = await proxyAndReader();
    await exchange("/v1/models", null);
    const before = lines(runName);

    const stream = await subscribe(reader.port, `/recordings/${runName}`);
    expect(await stream.take(before.length)).toEqual(expected(before));
    await exchange("/v1/models?n=2", null);

    expect(await stream.take(lines(runName).length - before.length)).toEqual(expected(lines(runName).slice(before.length), Buffer.byteLength(before.join("\n") + "\n")));
    stream.res.destroy();
  });

  it("stops waiting for writes when a reader of a followed recording leaves", async () => {
    let waiting = 0;
    const counted = (recordings: Recordings): Recordings => ({
      ...recordings,
      onWritten: (listener) => {
        waiting++;
        const stop = recordings.onWritten(listener);
        return () => {
          waiting--;
          stop();
        };
      },
    });
    const { recordings, reader, readerLog } = await proxyAndReader(undefined, counted);
    recordings.create();

    const stream = await subscribe(reader.port, `/recordings/${agentName}`);
    await readerLog.next();
    expect(waiting).toBe(1);
    stream.res.destroy();

    expect(await reader.next()).toMatchObject({ event: "request", outcome: "aborted" });
    expect(waiting).toBe(0);
  });

  it("logs a reader that leaves mid-catch-up, held by backpressure, as aborted with what it was read", async () => {
    const dir = recordingsDir();
    const line = JSON.stringify({ data: "x".repeat(1000) });
    writeFileSync(join(dir, pastRun), `${line}\n`.repeat(20_000));
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);
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
    writeFileSync(join(dir, pastRun), `${line}\n`.repeat(20_000));
    const { log, next } = eventLog();
    const reader = await serve(log, readerOver(log, createRecordings(() => {}, dir, runName)), 0);
    await next();

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);
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
    const dir = recordingsDir();
    writeFileSync(join(dir, pastRun), "");
    const recordings = createRecordings(() => {}, dir, runName);
    const { promise: listed, resolve: list } = Promise.withResolvers<void>();
    // The reader asks whether the recording is followed once the directory is listed.
    const watched = Object.defineProperty({ ...recordings }, "follows", { get: () => (list(), recordings.follows) });
    const { events: logged, log } = eventsWritten();
    const handle = readerOver(log, watched);
    let closed: Promise<void> | undefined;
    const reader = await serve(
      log,
      (req, res, work) => {
        handle(req, res, work);
        closed = reader.close();
      },
      0,
    );

    await expect(send(reader.port, { path: `/recordings/${pastRun}` })).rejects.toThrow(/socket hang up/);
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
    const upstream = await serving((_req, res) => res.end("answer"));
    // A file size limit of 8 blocks: 4096 or 8192 bytes, as the shell counts them. The exchange's first
    // event, its request, is over 10 KB: POSIX has a write with less room than it asks for write what fits,
    // so writing it writes up to the limit, and carrying on fails with EFBIG. Its later
    // events are small enough to fit below the limit.
    const { proxyPort, readerPort } = await proxyProcess(upstream.url, dir, "8");

    // The recording is made by the proxy, over its reader port, as the app server's launch asks.
    const { name } = parseListing((await buffer(await send(readerPort, { method: "POST", path: "/recordings" }))).toString());
    const path = join(dir, name);
    const stream = await subscribe(readerPort, `/recordings/${name}`);
    await buffer(await send(proxyPort, { path: `${agentBaseUrl("", name)}/v1/models?pad=${"x".repeat(10_000)}` }));
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

  it("logs a file read that fails after its reader left as the request's late_failure, not as the reader leaving", async () => {
    const dir = recordingsDir();
    writeFileSync(join(dir, pastRun), `${JSON.stringify({ type: "request" })}\n`);
    const reading = Promise.withResolvers<void>();
    const failing = Promise.withResolvers<never>();
    const gated = (recordings: Recordings): Recordings => ({ ...recordings, read: () => (reading.resolve(), failing.promise) });
    const { reader, readerLog } = await proxyAndReader(dir, gated);

    const stream = await subscribe(reader.port, `/recordings/${pastRun}`);
    await reading.promise;
    stream.res.destroy();
    const left = await reader.next();
    expect(left).toMatchObject({ event: "request", outcome: "aborted" });
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "aborted" });

    failing.reject(new Error("EIO: i/o error, read"));
    expect(await reader.next()).toMatchObject({ event: "late_failure", unit: "request", trace_id: left.trace_id, error: expect.stringContaining("EIO") });
  });

  it("makes a read error after the response started the request's error, and ends the stream with a failed event", async () => {
    const dir = recordingsDir();
    // The agent's recording is a directory: it opens, and measuring it fails with EISDIR.
    mkdirSync(join(dir, agentName));
    const { reader, readerLog } = await proxyAndReader(dir);

    const stream = await subscribe(reader.port, `/recordings/${agentName}`);
    const ended = once(stream.res, "end");

    const failed = await stream.next();
    await ended;
    expect(failed).toEqual({ event: "failed", data: expect.any(String) });
    const { error: message } = parseFailure(failed.data);
    expect(message).toMatch(/^EISDIR/);
    expect(await readerLog.next()).toMatchObject({ event: "catch_up", outcome: "error", error: expect.stringContaining(message) });
    expect(await reader.next()).toMatchObject({ event: "request", outcome: "error", error: expect.stringContaining(message), status: 200 });
  });
});
