import { agentBaseUrl, parseListing, type ProxyStatus, type RecordedEvent, type RecordingEnd } from "@cc-dump/proxy/format";
import { proxyProcess } from "@cc-dump/proxy/testing";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { serve, type Event } from "@cc-dump/log";
import { LOOPBACK } from "@cc-dump/log/address";
import { processLog } from "@cc-dump/log/lines";
import { arrivals, send, serving, traceIdOf, workEvent as event } from "@cc-dump/log/testing";
import { PassThrough } from "node:stream";
import { app, terminal, TmuxRefused } from "@cc-dump/server/testing";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createBrowserConnection } from "./browser.ts";
import type { Part } from "./connection.ts";

const finishedName = "run-20261113T080000.000Z.jsonl";
const finishedEvents: RecordedEvent[] = [
  { timestamp: "2026-11-13T08:00:00.000Z", trace_id: traceIdOf("a"), type: "request", method: "GET", url: "/v1/models", http_version: "1.1", headers: [] },
  { timestamp: "2026-11-13T08:00:01.000Z", trace_id: traceIdOf("a"), type: "end", outcome: "aborted" },
];

// The proxy as its own process, recording into a directory that holds a past run's recording a write left cut off,
// with an upstream that answers every request, and the browser connection to its reader.
async function proxyAndConnection() {
  const dir = join(mkdtempSync(join(tmpdir(), "cc-dump-")), "recordings");
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, finishedName), `${finishedEvents.map((event) => JSON.stringify(event)).join("\n")}\n{"tim`);
  const upstream = await serving((_req, res) => res.end("answer"));
  const proxy = await proxyProcess(upstream.url, dir, "unlimited");
  // The next event of the proxy's log that `matches`.
  const logged = async (matches: (event: Event) => boolean) => {
    for (let event = await proxy.next(); ; event = await proxy.next()) if (matches(event)) return event;
  };
  // A new agent's recording, as the proxy makes one, which is the one it follows.
  const newRecording = async () => parseListing((await buffer(await send(proxy.readerPort, { method: "POST", path: "/recordings" }))).toString()).name;
  return { dir, proxy, logged, newRecording, connection: createBrowserConnection({ readerPort: proxy.readerPort }) };
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

type StatusArrival = { status: ProxyStatus } | "dropped" | { failed: Error };

// The proxy's status, whose arrivals the test waits on, as `reading` does a read's.
function statusing(connection: ReturnType<typeof createBrowserConnection>) {
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const { arrive, next } = arrivals<StatusArrival>();
  connection.status({ status: (status) => arrive({ status }), dropped: () => arrive("dropped"), failed: (failed) => arrive({ failed }) }, abort.signal);
  return { abort, next };
}

const info = { base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/", recordings: "/recordings" };

// A status of the proxy watching its source, with `changed_source` changed, and no traffic.
const watching = (...changed_source: string[]): ProxyStatus => ({ info, source: { state: "watching", changed_source }, traffic: { in_flight: 0, last_request: null } });

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
  it("lists the recordings by name, an agent's once its process has written to it", async () => {
    const { connection } = await proxyAndConnection();
    expect(await connection.recordings(new AbortController().signal)).toEqual([{ name: finishedName }]);
  });

  it("fails a list it could not get, naming what it asked", async () => {
    const { proxy } = await proxyAndConnection();
    const port = proxy.proxyPort; // the proxy's own port, which forwards and has no list
    await expect(createBrowserConnection({ readerPort: port }).recordings(new AbortController().signal)).rejects.toMatchObject({
      message: `GET http://${LOOPBACK}:${port}/recordings`,
      cause: expect.any(Error),
    });
  });

  it("reads a finished recording's events, then its end", async () => {
    const { connection } = await proxyAndConnection();
    const read = reading(connection, finishedName);
    expect([await read.next(), await read.next(), await read.next()]).toEqual([...finishedEvents.map((event) => ({ event })), { end: { unterminated_bytes: 5 } }]);
  });

  it("reads an agent's recording as it is written: every event, parsed, in file order", async () => {
    const { dir, proxy, logged, newRecording, connection } = await proxyAndConnection();
    const agentName = await newRecording();
    const read = reading(connection, agentName);
    await logged(({ event, followed }) => event === "catch_up" && followed === true);
    await buffer(await send(proxy.proxyPort, { path: `${agentBaseUrl("", agentName)}/v1/models` }));
    const arrivals: Arrival[] = [];
    for (let arrival = await read.next(); ; arrival = await read.next()) {
      arrivals.push(arrival);
      if ("event" in arrival && arrival.event.type === "end") break;
    }
    const written = readFileSync(join(dir, agentName), "utf8").split("\n").filter(Boolean);
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
          message: `GET http://${LOOPBACK}:${proxy.readerPort}/recordings/${name}`,
          cause: expect.objectContaining({ message: expect.stringContaining("recorded event: type is not one of") }),
        }),
      },
    ]);
    // The lines after it arrive in the same chunk, so any event dispatched after the read closed is queued by now.
    expect(read.queued()).toBe(0);
  });

  it("ends a read at a trace's second end, reporting it as failed and nothing after it", async () => {
    const { dir, proxy, connection } = await proxyAndConnection();
    const name = "20261113T083000.000Z.jsonl";
    const [request, end] = finishedEvents.map((event) => JSON.stringify(event));
    writeFileSync(join(dir, name), `${request}\n${end}\n${end}\n${request}\n`);
    const read = reading(connection, name);
    expect([await read.next(), await read.next(), await read.next()]).toEqual([
      ...finishedEvents.map((event) => ({ event })),
      {
        failed: expect.objectContaining({
          message: `GET http://${LOOPBACK}:${proxy.readerPort}/recordings/${name}`,
          cause: expect.objectContaining({ message: `recorded end event: trace ${traceIdOf("a")} already has one` }),
        }),
      },
    ]);
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
        message: `GET http://${LOOPBACK}:${proxy.readerPort}/recordings/${name}`,
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
    const read = reading(createBrowserConnection({ readerPort: reader.port }), finishedName);
    expect([await read.next(), await read.next(), await read.next()]).toEqual([...finishedEvents.map((event) => ({ event })), { end: { unterminated_bytes: 0 } }]);
    expect(resumedFrom).toEqual([undefined, "7"]);
    expect(read.queued()).toBe(0);
  });

  it("reports a read of a recording the proxy does not list as failed", async () => {
    const { connection } = await proxyAndConnection();
    const arrival = await reading(connection, "run-20261113T070000.000Z.jsonl").next();
    expect(arrival).toEqual({ failed: expect.objectContaining({ message: expect.stringMatching(/\/recordings\/run-20261113T070000\.000Z\.jsonl: not served; /) }) });
  });

  it("ends the read at the proxy when it is aborted", async () => {
    const { logged, newRecording, connection } = await proxyAndConnection();
    const agentName = await newRecording();
    const read = reading(connection, agentName);
    await logged(({ event }) => event === "catch_up");
    read.abort.abort();
    expect(await logged(({ event }) => event === "request")).toMatchObject({ url: `/recordings/${agentName}`, outcome: "aborted" });
  });

  it("follows the running proxy's status, which says what the proxy is", async () => {
    const { dir, proxy, connection } = await proxyAndConnection();
    // The proxy watches the repo's own source, which a save while the test runs changes.
    expect(await statusing(connection).next()).toEqual({
      status: {
        info: { base_url: `http://${LOOPBACK}:${proxy.proxyPort}`, upstream: expect.any(String), recordings: dir },
        source: { state: "watching", changed_source: expect.any(Array) },
        traffic: { in_flight: 0, last_request: null },
      },
    });
  });

  it("makes a recording for an agent started by hand, one each time", async () => {
    const { dir, connection } = await proxyAndConnection();
    const [first, second] = [await connection.agentRecording(), await connection.agentRecording()];
    expect(first.name).not.toBe(second.name);
    expect(readFileSync(join(dir, first.name), "utf8")).toBe("");
  });

  it("delivers each status as it changes, a failed watch's too, and goes on following", async () => {
    const sources = watchEventSources();
    const statuses: ProxyStatus[] = [
      watching(),
      watching("/proxy/src/proxy.ts"),
      { info, source: { state: "failed", message: "EMFILE: too many open files, watch" }, traffic: { in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" } },
    ];
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(statuses.map((status) => `data: ${JSON.stringify(status)}\n\n`).join(""));
    });
    const status = statusing(createBrowserConnection({ readerPort: reader.port }));
    expect([await status.next(), await status.next(), await status.next()]).toEqual(statuses.map((status) => ({ status })));
    expect(sources.map((source) => source.readyState)).toEqual([EventSource.OPEN]);
  });

  it("reports a status that does not parse as failed, and goes on to the statuses after it", async () => {
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"state":"watching","changed_source":[]}\n\ndata: ${JSON.stringify(watching())}\n\n`);
    });
    const status = statusing(createBrowserConnection({ readerPort: reader.port }));
    expect([await status.next(), await status.next()]).toEqual([
      {
        failed: expect.objectContaining({
          message: `GET ${reader.url}/status`,
          cause: expect.objectContaining({ message: "proxy status: source: is not an object" }),
        }),
      },
      { status: watching() },
    ]);
  });

  it("follows the proxy across a restart: the connection, dropped, reconnects to the restarted proxy's status", async () => {
    const statuses: ProxyStatus[] = [watching("/proxy/src/proxy.ts"), watching()];
    let connections = 0;
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const status = `data: ${JSON.stringify(statuses[connections++])}\n\n`;
      // The first proxy stops after its status; `retry` makes the browser reconnect in 10ms, not its default 3s.
      if (connections === 1) res.write(`retry: 10\n${status}`, () => res.destroy());
      else res.write(status);
    });
    const status = statusing(createBrowserConnection({ readerPort: reader.port }));
    expect([await status.next(), await status.next(), await status.next()]).toEqual([{ status: statuses[0] }, "dropped", { status: statuses[1] }]);
  });

  it("reports a proxy not reached as dropped, and its status once it is", async () => {
    // A port nothing listens on yet: the first connection is refused, and the browser tries again.
    const { port, close } = await serve(() => {}, (_req, res) => res.end(), 0);
    await close();
    const status = statusing(createBrowserConnection({ readerPort: port }));
    expect(await status.next()).toBe("dropped");
    const reader = serve(
      () => {},
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(watching())}\n\n`);
      },
      port,
    );
    onTestFinished(async () => (await reader).close());
    let arrival = await status.next();
    while (arrival === "dropped") arrival = await status.next();
    expect(arrival).toEqual({ status: watching() });
  });

  it("reports a status not served as failed", async () => {
    const reader = await serving((_req, res) => res.writeHead(404).end());
    expect(await statusing(createBrowserConnection({ readerPort: reader.port })).next()).toEqual({
      failed: expect.objectContaining({ message: expect.stringMatching(/\/status: not served; /) }),
    });
  });
});

type LogArrival = "opened" | { line: string } | "dropped" | { failed: Error };

// A part's log, whose arrivals the test waits on, each line by its event's name.
function logging(connection: ReturnType<typeof createBrowserConnection>, part: Part) {
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const { arrive, next } = arrivals<LogArrival>();
  connection.logs(
    part,
    { opened: () => arrive("opened"), line: (line) => arrive({ line: "event" in line ? line.event.event : `unread: ${line.error}` }), dropped: () => arrive("dropped"), failed: (failed) => arrive({ failed }) },
    abort.signal,
  );
  return { next };
}

describe("a part's log", () => {

  it("reads the app server's lines kept, then each as it is written", async () => {
    const { log, logs } = processLog("server", new PassThrough());
    log(event("kept"));
    const server = await serving(logs);
    const logged = logging(createBrowserConnection({ serverPort: server.port }), "server");
    expect([await logged.next(), await logged.next()]).toEqual(["opened", { line: "kept" }]);
    log(event("written"));
    expect(await logged.next()).toEqual({ line: "written" });
  });

  it("resumes the proxy's lines after the last one read, once a dropped connection is made again", async () => {
    const { log, logs } = processLog("proxy", new PassThrough());
    log(event("before"));
    let connections = 0;
    // The first connection is cut once its lines are sent; `retry` makes the browser reconnect in 10ms, not its default 3s.
    const reader = await serving((req, res, work) => {
      logs(req, res, work);
      if (++connections === 1) res.write("retry: 10\n\n", () => res.destroy());
    });
    const logged = logging(createBrowserConnection({ readerPort: reader.port }), "proxy");
    expect([await logged.next(), await logged.next(), await logged.next()]).toEqual(["opened", { line: "before" }, "dropped"]);
    log(event("after"));
    expect([await logged.next(), await logged.next()]).toEqual(["opened", { line: "after" }]);
  });

  it("delivers a line whose event does not parse unread, and goes on to the lines after it", async () => {
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: ab:0\ndata: {}\n\nid: ab:1\ndata: ${JSON.stringify({ service: "proxy", ...event("next") })}\n\n`);
    });
    const logged = logging(createBrowserConnection({ readerPort: reader.port }), "proxy");
    expect([await logged.next(), await logged.next(), await logged.next()]).toEqual(["opened", { line: "unread: log line: service is not a string" }, { line: "next" }]);
  });

  it("ends a log whose message has no line's position, reporting it as failed", async () => {
    const reader = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ service: "proxy", ...event("nowhere") })}\n\n`);
    });
    const logged = logging(createBrowserConnection({ readerPort: reader.port }), "proxy");
    expect([await logged.next(), await logged.next()]).toEqual([
      "opened",
      { failed: expect.objectContaining({ message: `GET ${reader.url}/logs`, cause: expect.objectContaining({ message: 'log line: id "" is not run:seq' }) }) },
    ]);
  });
});

describe("launching", () => {
  const signal = () => new AbortController().signal;

  it("reads the launcher and launches through the app server", async () => {
    const { port, opened } = await app();
    const connection = createBrowserConnection({ serverPort: port });
    expect(await connection.launcher(signal())).toEqual({ settings: { session: null, command: "claude" }, sessions: ["work", "play"] });
    expect(await connection.launch({ session: "play", command: "claude -c" }, signal())).toEqual({ session: "play", start_time: 1794801953, session_id: "$2", window_id: "@7", pane_id: "%9", recording: expect.any(String) });
    expect(opened).toMatchObject([{ session: "play", command: "claude -c" }]);
  });

  it("fails a refusal in the app server's words, tmux's own when tmux refused", async () => {
    const { port } = await app({ tmux: { sessions: () => Promise.reject(new TmuxRefused("no sessions")), newWindow: () => Promise.reject(new TmuxRefused("can't find session: gone")) } });
    const connection = createBrowserConnection({ serverPort: port });
    await expect(connection.launcher(signal())).rejects.toThrow(new Error("no sessions"));
    await expect(connection.launch({ session: "gone", command: "claude" }, signal())).rejects.toThrow(new Error("can't find session: gone"));
  });

  it("fails naming the request when the app server cannot be reached", async () => {
    // A port a server bound and closed, so nothing answers on it.
    const { port, close } = await serve(() => {}, (_req, res) => res.end(), 0);
    await close();
    await expect(createBrowserConnection({ serverPort: port }).launcher(signal())).rejects.toMatchObject({
      message: `GET http://${LOOPBACK}:${port}/launch`,
      cause: expect.any(Error),
    });
  });
});

describe("a terminal's connection", () => {
  it("connects when its owner connects it, and closing it detaches its tmux client at once", async () => {
    const { port, windowOf, clients } = await terminal("work");
    const tmux = createBrowserConnection({ serverPort: port }).tmux(windowOf("work"));
    onTestFinished(() => tmux.close());

    await tmux.connect();
    expect(await tmux.execute("display-message -p '#{session_name}'")).toMatchObject({ output: ["work"] });
    expect(clients()).toEqual(["work"]);

    await tmux.close();
    await expect(tmux.execute("display-message -p ok")).rejects.toThrow();
    await vi.waitFor(() => expect(clients()).toEqual([]));
  });

  it("connects again after it is closed, as a terminal remounted connects the one it made", async () => {
    const { port, windowOf } = await terminal("work");
    const tmux = createBrowserConnection({ serverPort: port }).tmux(windowOf("work"));
    onTestFinished(() => tmux.close());

    await tmux.connect();
    await tmux.close();
    await tmux.connect();
    expect(await tmux.execute("display-message -p ok")).toMatchObject({ output: ["ok"] });
  });

  it("is a new one each time it is asked for, so closing one leaves another live", async () => {
    const { port, windowOf } = await terminal("work");
    const connection = createBrowserConnection({ serverPort: port });
    const [first, second] = [connection.tmux(windowOf("work")), connection.tmux(windowOf("work"))];
    onTestFinished(async () => void (await Promise.all([first.close(), second.close()])));

    await Promise.all([first.connect(), second.connect()]);
    await first.close();
    expect(await second.execute("display-message -p ok")).toMatchObject({ output: ["ok"] });
  });
});
