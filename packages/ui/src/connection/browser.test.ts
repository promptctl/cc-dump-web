import type { ProxyStatus, RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { proxyProcess } from "@cc-dump/proxy/testing";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import type { Event } from "@cc-dump/log";
import { arrivals, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createBrowserConnection } from "./browser.ts";

const finishedName = "20261113T080000.000Z.jsonl";
const liveName = "20261113T090000.000Z.jsonl";
const finishedEvents: RecordedEvent[] = [
  { timestamp: "2026-11-13T08:00:00.000Z", trace_id: "a", type: "request", method: "GET", url: "/v1/models", http_version: "1.1", headers: [] },
  { timestamp: "2026-11-13T08:00:01.000Z", trace_id: "a", type: "end", outcome: "aborted" },
];

// The proxy as its own process, recording to the live recording beside a finished one that a write left cut off,
// with an upstream that answers every request, and the browser connection to its reader.
async function proxyAndConnection() {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-dump-")), "recordings");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, finishedName), `${finishedEvents.map((event) => JSON.stringify(event)).join("\n")}\n{"tim`);
  const upstream = await serving((_req, res) => res.end("answer"));
  const proxy = await proxyProcess(upstream.url, join(dir, liveName), "unlimited");
  // The next event of the proxy's log that `matches`.
  const logged = async (matches: (event: Event) => boolean) => {
    for (let event = await proxy.next(); ; event = await proxy.next()) if (matches(event)) return event;
  };
  return { dir, proxy, logged, connection: createBrowserConnection(`http://127.0.0.1:${proxy.readerPort}`) };
}

type Arrival = { event: RecordedEvent } | { end: RecordingEnd } | { failed: Error };

// A read whose arrivals the test waits on: `next()` resolves with each in turn. Aborted when the test finishes.
function reading(connection: ReturnType<typeof createBrowserConnection>, name: string) {
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const { arrive, next, queued } = arrivals<Arrival>();
  connection.read(name, { event: (event) => arrive({ event }), end: (end) => arrive({ end }), failed: (failed) => arrive({ failed }) }, abort.signal);
  return { abort, next, queued };
}

type StatusArrival = { status: ProxyStatus } | { failed: Error };

// The proxy's status, whose arrivals the test waits on, as `reading` does a read's.
function statusing(connection: ReturnType<typeof createBrowserConnection>) {
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const { arrive, next } = arrivals<StatusArrival>();
  connection.status({ status: (status) => arrive({ status }), failed: (failed) => arrive({ failed }) }, abort.signal);
  return { abort, next };
}

// Each EventSource opened while the test runs.
function watchEventSources() {
  const sources: EventSource[] = [];
  vi.stubGlobal(
    "EventSource",
    class extends EventSource {
      constructor(...args: ConstructorParameters<typeof EventSource>) {
        super(...args);
        sources.push(this);
      }
    },
  );
  onTestFinished(() => void vi.unstubAllGlobals());
  return sources;
}

describe("the browser connection", () => {
  it("lists the recordings, oldest first, the live one marked", async () => {
    const { connection } = await proxyAndConnection();
    expect(await connection.recordings(new AbortController().signal)).toEqual([
      { name: finishedName, live: false },
      { name: liveName, live: true },
    ]);
  });

  it("fails a list it could not get, naming what it asked", async () => {
    const { proxy } = await proxyAndConnection();
    const origin = `http://127.0.0.1:${proxy.proxyPort}`; // the proxy's own port, which forwards and has no list
    await expect(createBrowserConnection(origin).recordings(new AbortController().signal)).rejects.toMatchObject({
      message: `GET ${origin}/recordings`,
      cause: expect.any(Error),
    });
  });

  it("reads a finished recording's events, then its end", async () => {
    const { connection } = await proxyAndConnection();
    const read = reading(connection, finishedName);
    expect([await read.next(), await read.next(), await read.next()]).toEqual([...finishedEvents.map((event) => ({ event })), { end: { unterminated_bytes: 5 } }]);
  });

  it("reads the live recording as it is written: every event, parsed, in file order", async () => {
    const { dir, proxy, logged, connection } = await proxyAndConnection();
    const read = reading(connection, liveName);
    await logged(({ event, live }) => event === "catch_up" && live === true);
    await buffer(await send(proxy.proxyPort, { path: "/v1/models" }));
    const arrivals: Arrival[] = [];
    for (let arrival = await read.next(); ; arrival = await read.next()) {
      arrivals.push(arrival);
      if ("event" in arrival && arrival.event.type === "end") break;
    }
    const written = readFileSync(join(dir, liveName), "utf8").split("\n").filter(Boolean);
    expect(arrivals).toEqual(written.map((line) => ({ event: JSON.parse(line) })));
    expect(arrivals.map((arrival) => "event" in arrival && arrival.event.type)).toEqual(["request", "request_trailers", "response", "response_body", "response_trailers", "end"]);
  });

  it("ends a read at a line that does not parse, reporting it as failed and nothing after it", async () => {
    const { dir, proxy, connection } = await proxyAndConnection();
    const name = "20261113T083000.000Z.jsonl";
    const [request, end] = finishedEvents.map((event) => JSON.stringify(event));
    writeFileSync(join(dir, name), `${request}\n{"type":"response_footer"}\n${end}\n`);
    const read = reading(connection, name);
    expect([await read.next(), await read.next()]).toEqual([
      { event: finishedEvents[0] },
      {
        failed: expect.objectContaining({
          message: `GET http://127.0.0.1:${proxy.readerPort}/recordings/${name}`,
          cause: expect.objectContaining({ message: expect.stringContaining("recorded event: type is not one of") }),
        }),
      },
    ]);
    // The lines after it arrive in the same chunk, so any event dispatched after the read closed is queued by now.
    expect(read.queued()).toBe(0);
  });

  it("reports a read the reader failed once it began as failed, with the reader's error, and closes it so it is not read again", async () => {
    const { dir, proxy, logged, connection } = await proxyAndConnection();
    // A recording that is a directory: listed, and read from its start, so the reader sends its headers and
    // then fails, reading it, with EISDIR.
    const name = "20261113T083000.000Z.jsonl";
    mkdirSync(join(dir, name));
    const sources = watchEventSources();

    expect(await reading(connection, name).next()).toEqual({
      failed: expect.objectContaining({
        message: `GET http://127.0.0.1:${proxy.readerPort}/recordings/${name}`,
        cause: expect.objectContaining({ message: expect.stringContaining("EISDIR") }),
      }),
    });
    // A closed EventSource never reconnects.
    expect(sources.map((source) => source.readyState)).toEqual([EventSource.CLOSED]);
    expect(await logged(({ event }) => event === "request")).toMatchObject({ url: `/recordings/${name}`, outcome: "error", status: 200 });
  });

  it("resumes a read whose connection dropped from its last event, reporting nothing", async () => {
    const [first, second] = finishedEvents.map((event) => JSON.stringify(event));
    const resumedFrom: (string | string[] | undefined)[] = [];
    const reader = await serving((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      resumedFrom.push(req.headers["last-event-id"]);
      // `retry` makes the browser reconnect in 10ms, not its default 3s.
      if (resumedFrom.length === 1) res.write(`retry: 10\nid: 7\ndata: ${first}\n\n`, () => res.destroy());
      else res.end(`id: 14\ndata: ${second}\n\nevent: end\ndata: {"unterminated_bytes":0}\n\n`);
    });
    const read = reading(createBrowserConnection(reader.url), finishedName);
    expect([await read.next(), await read.next(), await read.next()]).toEqual([...finishedEvents.map((event) => ({ event })), { end: { unterminated_bytes: 0 } }]);
    expect(resumedFrom).toEqual([undefined, "7"]);
    expect(read.queued()).toBe(0);
  });

  it("reports a read of a recording the proxy does not list as failed", async () => {
    const { connection } = await proxyAndConnection();
    const arrival = await reading(connection, "20261113T070000.000Z.jsonl").next();
    expect(arrival).toEqual({ failed: expect.objectContaining({ message: expect.stringMatching(/\/recordings\/20261113T070000\.000Z\.jsonl: not served; /) }) });
  });

  it("ends the read at the proxy when it is aborted", async () => {
    const { logged, connection } = await proxyAndConnection();
    const read = reading(connection, liveName);
    await logged(({ event }) => event === "catch_up");
    read.abort.abort();
    expect(await logged(({ event }) => event === "request")).toMatchObject({ url: `/recordings/${liveName}`, outcome: "aborted" });
  });

  it("follows the proxy's status: the running proxy's source is unchanged", async () => {
    const { connection } = await proxyAndConnection();
    expect(await statusing(connection).next()).toEqual({ status: { state: "watching", changed_source: [] } });
  });

  it("delivers each status as it changes, a failed watch's too, and goes on following", async () => {
    const sources = watchEventSources();
    const statuses: ProxyStatus[] = [
      { state: "watching", changed_source: [] },
      { state: "watching", changed_source: ["/proxy/src/proxy.ts"] },
      { state: "failed", message: "EMFILE: too many open files, watch" },
    ];
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(statuses.map((status) => `data: ${JSON.stringify(status)}\n\n`).join(""));
    });
    const status = statusing(createBrowserConnection(reader.url));
    expect([await status.next(), await status.next(), await status.next()]).toEqual(statuses.map((status) => ({ status })));
    expect(sources.map((source) => source.readyState)).toEqual([EventSource.OPEN]);
  });

  it("reports a status that does not parse as failed, and goes on to the statuses after it", async () => {
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"state":"watching","changed_source":"proxy.ts"}\n\ndata: {"state":"watching","changed_source":[]}\n\n`);
    });
    const status = statusing(createBrowserConnection(reader.url));
    expect([await status.next(), await status.next()]).toEqual([
      {
        failed: expect.objectContaining({
          message: `GET ${reader.url}/status`,
          cause: expect.objectContaining({ message: "proxy status: changed_source is not a list of strings" }),
        }),
      },
      { status: { state: "watching", changed_source: [] } },
    ]);
  });

  it("follows the proxy across a restart: the dropped connection reconnects to the restarted proxy's status", async () => {
    const statuses: ProxyStatus[] = [
      { state: "watching", changed_source: ["/proxy/src/proxy.ts"] },
      { state: "watching", changed_source: [] },
    ];
    let connections = 0;
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const status = `data: ${JSON.stringify(statuses[connections++])}\n\n`;
      // The first proxy stops after its status; `retry` makes the browser reconnect in 10ms, not its default 3s.
      if (connections === 1) res.write(`retry: 10\n${status}`, () => res.destroy());
      else res.write(status);
    });
    const status = statusing(createBrowserConnection(reader.url));
    expect([await status.next(), await status.next()]).toEqual(statuses.map((status) => ({ status })));
  });

  it("reports a status not served as failed", async () => {
    const reader = await serving((_req, res) => res.writeHead(404).end());
    expect(await statusing(createBrowserConnection(reader.url)).next()).toEqual({
      failed: expect.objectContaining({ message: expect.stringMatching(/\/status: not served; /) }),
    });
  });
});
