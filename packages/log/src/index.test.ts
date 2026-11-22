import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { buffer } from "node:stream/consumers";
import { setTimeout } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { LOOPBACK } from "./address.ts";
import { createLog, failed, logged, loggedAfter, serve, unitOfWork, type Event, type Work } from "./index.ts";
import { eventLog, eventsWritten, send, sendRaw, serving } from "./testing.ts";
import { parseTraceId } from "./trace.ts";

const ended: Event = { event: "e", trace_id: parseTraceId("t"), started_at: "s", duration_ms: 0, outcome: "ok" };

// @ts-expect-error An event that ended well cannot carry an error.
const contradictory: Event = { ...ended, error: "boom" };
void contradictory;

// @ts-expect-error A part hands serve its handler, never a server it made itself.
const unlogged = () => serve(() => {}, createHttpServer(), 0);
void unlogged;

// @ts-expect-error A unit of work's facts never replace the floor's fields, the sink's service included.
const replacing = () => logged(() => {}, "setup", { service: "other" }, () => 7);
void replacing;

// @ts-expect-error The work is synchronous: a promise's event would be written before the work happened.
const early = () => logged(() => {}, "setup", {}, async () => 7);
void early;

// A node:http server of its own, not serve's, answering 418, on a free port of `host` until the test finishes; with no
// host, node's wildcard.
async function bare(host?: string, port = 0) {
  const server = createHttpServer((_req, res) => res.writeHead(418).end()).listen(port, host);
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

describe("createLog", () => {
  it("writes each event as one JSON line naming its service", () => {
    const lines: string[] = [];
    createLog("proxy", (line) => lines.push(line))({ ...ended, port: 1 });

    expect(lines).toEqual([`${JSON.stringify({ service: "proxy", ...ended, port: 1 })}\n`]);
  });
});

describe("logged", () => {
  it("records the work's facts beside the floor's fields, and returns its result", async () => {
    const { log, next } = eventLog();

    expect(logged(log, "setup", { path: "/a" }, () => 7)).toBe(7);
    expect(await next()).toMatchObject({ event: "setup", path: "/a", outcome: "ok", trace_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it("records and rethrows the work's error", async () => {
    const { log, next } = eventLog();

    expect(() =>
      logged(log, "setup", {}, () => {
        throw new Error("no room");
      }),
    ).toThrow("no room");
    expect(await next()).toMatchObject({ event: "setup", outcome: "error", error: expect.stringContaining("no room") });
  });

  it("records the facts found in the work's result", async () => {
    const { log, next } = eventLog();

    logged(log, "setup", { path: "/a" }, () => ({ port: 7 }), ({ port }) => ({ port }));
    expect(await next()).toMatchObject({ event: "setup", path: "/a", port: 7, outcome: "ok" });
  });

  it("writes the error event, then rethrows, when reading the work's facts throws", async () => {
    const { log, next } = eventLog();
    const found = () => {
      throw new Error("no such fact");
    };

    expect(() => logged(log, "setup", {}, () => 7, found)).toThrow("no such fact");
    expect(await next()).toMatchObject({ event: "setup", outcome: "error", error: expect.stringContaining("no such fact") });
  });
});

describe("loggedAfter", () => {
  it("records work timed elsewhere, in the trace it is part of, as started its duration before now", async () => {
    const { log, next } = eventLog();
    const before = Date.now();

    loggedAfter(log, parseTraceId("t1"), "call", { method: "send-keys" }, 900, { outcome: "ok" });
    const event = await next();
    expect(event).toMatchObject({ event: "call", trace_id: "t1", method: "send-keys", duration_ms: 900, outcome: "ok" });
    expect(Date.parse(event.started_at)).toBeGreaterThanOrEqual(before - 900);
    expect(Date.parse(event.started_at)).toBeLessThanOrEqual(Date.now() - 900);
  });

  it("records the failure it reports", async () => {
    const { log, next } = eventLog();

    loggedAfter(log, parseTraceId("t1"), "call", {}, 0, failed(new Error("denied")));
    expect(await next()).toMatchObject({ event: "call", outcome: "error", error: expect.stringContaining("denied") });
  });
});

describe("unitOfWork", () => {
  const trace_id = parseTraceId("t1");
  const span = { trace_id, end: () => ({ trace_id, started_at: "s", duration_ms: 0 }) };
  const sinkGone = () => {
    throw new Error("sink gone");
  };

  it("writes the first ending it is given, and no later one", async () => {
    const { events, log } = eventsWritten();
    const unit = unitOfWork(log, "read", { from: 0 }, span);

    unit.end({ outcome: "aborted" }, () => ({ to: 4 }));
    unit.end(failed(new Error("late")), () => ({ to: 9 }));
    expect(events).toEqual([{ event: "read", from: 0, ...span.end(), to: 4, outcome: "aborted" }]);
    expect(await unit.ended).toEqual({ outcome: "aborted" });
  });

  it("ends with the first failure reported, over the ending the work reached", async () => {
    const { events, log } = eventsWritten();
    const unit = unitOfWork(log, "request", {}, span);

    unit.fail(new Error("first"));
    unit.fail(new Error("second"));
    unit.end({ outcome: "ok" });
    expect(events).toMatchObject([{ outcome: "error", error: expect.stringContaining("first") }]);
    expect(events[0]!.error).not.toContain("second");
    expect(await unit.ended).toEqual({ outcome: "error", error: events[0]!.error });
  });

  it("writes a failure reported after its end as a late_failure of its own, in its trace, and its event stands", () => {
    const { events, log } = eventsWritten();
    const unit = unitOfWork(log, "request", { url: "/" }, span);

    unit.end({ outcome: "aborted" });
    unit.fail(new Error("EIO"));
    unit.fail(new Error("EACCES"));
    expect(events).toMatchObject([
      { event: "request", url: "/", outcome: "aborted" },
      { event: "late_failure", unit: "request", ...span.end(), outcome: "error", error: expect.stringContaining("EIO") },
      { event: "late_failure", unit: "request", outcome: "error", error: expect.stringContaining("EACCES") },
    ]);
    expect(events[1]).not.toHaveProperty("url");
  });

  it("writes the ending as its event judges it, and resolves `ended` with the unit's own", async () => {
    const { events, log } = eventsWritten();
    const unit = unitOfWork(log, "request", {}, span, () => failed(new Error("500 Internal Server Error")));

    unit.end({ outcome: "ok" });
    expect(events).toMatchObject([{ outcome: "error", error: expect.stringContaining("500") }]);
    expect(await unit.ended).toEqual({ outcome: "ok" });
  });

  it("measures the facts found only for the ending it writes", () => {
    const { log } = eventsWritten();
    const unit = unitOfWork(log, "read", {}, span);
    let measured = 0;

    unit.end({ outcome: "ok" }, () => ({ measured: ++measured }));
    unit.end({ outcome: "ok" }, () => ({ measured: ++measured }));
    expect(measured).toBe(1);
  });

  it("stays open when measuring its facts or its span throws, for the failure its caller gives", () => {
    const { events, log } = eventsWritten();
    let spans = 0;
    const unit = unitOfWork(log, "read", {}, { trace_id, end: () => (spans++ === 0 ? sinkGone() : span.end()) });

    expect(() => unit.end({ outcome: "ok" })).toThrow("sink gone");
    expect(() =>
      unit.end({ outcome: "ok" }, () => {
        throw new Error("EIO");
      }),
    ).toThrow("EIO");
    unit.end(failed(new Error("EIO")));
    expect(events).toMatchObject([{ event: "read", outcome: "error", error: expect.stringContaining("EIO") }]);
  });

  it("resolves `ended` before a write that throws, which surfaces as itself", async () => {
    const unit = unitOfWork(sinkGone, "request", {}, span);

    expect(() => unit.end({ outcome: "ok" })).toThrow("sink gone");
    expect(await unit.ended).toEqual({ outcome: "ok" });
  });

  it("attempts no second write after a write that throws, whatever catch it reaches", () => {
    let writes = 0;
    const log = () => {
      writes++;
      sinkGone();
    };

    expect(() => logged(log, "setup", {}, () => 7)).toThrow("sink gone");
    expect(writes).toBe(1);
  });
});

describe("serve", () => {
  it("emits one event for an answered request", async () => {
    const { url, next } = await serving((_req, res) => res.writeHead(204).end());

    await (await fetch(`${url}/a?b=1`, { method: "POST" })).text();

    expect(await next()).toMatchObject({
      event: "request",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      outcome: "ok",
      method: "POST",
      url: "/a?b=1",
      status: 204,
      client_address: LOOPBACK,
      client_port: expect.any(Number),
    });
  });

  it.each([
    { status: 404, reason: undefined, error: "404 Not Found" },
    { status: 405, reason: undefined, error: "405 Method Not Allowed" },
    { status: 429, reason: "Slow Down", error: "429 Slow Down" },
    { status: 503, reason: undefined, error: "503 Service Unavailable" },
  ])("records a request answered in full with $status as failed, by the answer's status line, with no word from the handler", async ({ status, reason, error }) => {
    let work!: Work;
    const { url, next } = await serving((_req, res, given) => {
      work = given;
      res.writeHead(status, reason).end();
    });

    await (await fetch(url)).text();

    expect(await next()).toMatchObject({ event: "request", outcome: "error", status, error });
    expect(await work.ended).toEqual({ outcome: "ok" });
  });

  it("records a request whose error answer its client left before it finished as aborted", async () => {
    const { url, next } = await serving((_req, res) => res.writeHead(404).flushHeaders());

    const abort = new AbortController();
    await fetch(url, { signal: abort.signal });
    abort.abort();

    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", status: 404 });
  });

  it("records an aborted request with no status when the client leaves first", async () => {
    let arrived!: () => void;
    const received = new Promise<void>((resolve) => (arrived = resolve));
    const { url, next } = await serving(() => arrived());

    const abort = new AbortController();
    const request = fetch(url, { signal: abort.signal }).catch(() => "aborted");
    await received;
    abort.abort();

    expect(await request).toBe("aborted");
    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", status: null });
  });

  it("records a failure the handler's work meets after its client left as the request's late_failure, which `close` does not wait on", async () => {
    const { log, next } = eventLog();
    const arrived = Promise.withResolvers<Work>();
    const { port, close } = await serve(log, (_req, _res, work) => arrived.resolve(work), 0);
    await next();

    const abort = new AbortController();
    const request = fetch(`http://${LOOPBACK}:${port}/`, { signal: abort.signal }).catch(() => "aborted");
    const work = await arrived.promise;
    abort.abort();
    expect(await request).toBe("aborted");
    const event = await next();
    expect(event).toMatchObject({ event: "request", outcome: "aborted" });

    work.fail(new Error("EACCES"));
    expect(await next()).toMatchObject({ event: "late_failure", unit: "request", trace_id: event.trace_id, outcome: "error", error: expect.stringContaining("EACCES") });
    await close();
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", requests_open: 0 });
  });

  it("records the first failure the handler reports, beside the answer it sent", async () => {
    const { url, next } = await serving((_req, res, { fail }) => {
      fail(new Error("first"));
      fail(new Error("second"));
      res.writeHead(502).end();
    });

    await (await fetch(url)).text();

    const event = await next();
    expect(event).toMatchObject({ event: "request", outcome: "error", status: 502, error: expect.stringContaining("first") });
    expect(event.error).not.toContain("second");
  });

  it("cuts and records the request of a handler that throws, and goes on serving", async () => {
    let calls = 0;
    const { url, next } = await serving((_req, res) => {
      if (++calls === 1) throw new TypeError("Invalid URL");
      res.end("served");
    });

    await expect(fetch(url)).rejects.toThrow();
    expect(await next()).toMatchObject({ event: "request", outcome: "error", status: null, error: expect.stringContaining("Invalid URL") });
    expect(await (await fetch(url)).text()).toBe("served");
  });

  it("hands the handler its request's trace_id, and the ending its event records once the response closes", async () => {
    let work!: Work;
    const { url, next } = await serving((_req, res, given) => {
      work = given;
      given.fail(new Error("boom"));
      res.end();
    });

    await (await fetch(url)).text();

    const event = await next();
    expect(work.trace_id).toBe(event.trace_id);
    expect(await work.ended).toEqual({ outcome: "error", error: event.error });
  });

  it("records a request node refuses before any handler, and leaves node's answer as node sent it", async () => {
    const { port, next } = await serving(() => expect.unreachable("no handler sees a malformed request"));

    const { reply, clientPort } = await sendRaw(port, "NOT HTTP\r\n\r\n");

    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(reply).toBe((await sendRaw(await bare(LOOPBACK), "NOT HTTP\r\n\r\n")).reply);
    expect(await next()).toMatchObject({
      event: "client_error",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      outcome: "error",
      error: expect.stringContaining("HPE_INVALID_METHOD"),
      client_port: clientPort,
    });
  });

  it("spans a connection error from the moment the connection opened", async () => {
    const { port, next } = await serving(() => expect.unreachable("no handler sees a malformed request"));

    const socket = createConnection(port, LOOPBACK);
    await once(socket, "connect");
    await setTimeout(100);
    socket.end("NOT HTTP\r\n\r\n").resume();

    expect((await next()).duration_ms).toBeGreaterThan(50);
  });

  it("records a connection error beside the request it cut, joined by the client's port", async () => {
    const { port, next } = await serving((req, res) => {
      req.resume();
      req.on("end", () => res.end());
    });

    const { reply, clientPort } = await sendRaw(port, "POST / HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n");

    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    const events = [await next(), await next()].sort((a, b) => a.event.localeCompare(b.event));
    expect(events).toMatchObject([
      { event: "client_error", error: expect.stringContaining("HPE_INVALID_CHUNK_SIZE"), client_port: clientPort },
      { event: "request", method: "POST", client_port: clientPort },
    ]);
  });

  // Its close event is written once node's server has stopped listening. The freed port is not probed: any process
  // may bind it at once (parallel tests do), and a probe would reach that process's server.
  it("records the port asked for, the port it bound, and closing it", async () => {
    const { log, next } = eventLog();

    const { port, close } = await serve(log, () => {}, 0);
    await close();

    expect(await next()).toMatchObject({ event: "listen", outcome: "ok", requested_port: 0, port });
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", port, requests_open: 0 });
  });

  it.each([200, 404])("cuts a request still open when closed, and resolves once its event, ended as stopped, is written, its answer's status %i or any", async (status) => {
    const { log, next } = eventLog();
    const { port, close } = await serve(log, (_req, res) => res.writeHead(status).flushHeaders(), 0);
    await next();
    const res = await send(port, { path: "/" });

    const cut = expect(buffer(res)).rejects.toThrow(/aborted/);
    await close();
    await cut;

    expect(await next()).toMatchObject({ event: "request", outcome: "stopped", status });
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", port, requests_open: 1 });
  });

  it("records and rethrows a close that fails", async () => {
    const { log, next } = eventLog();
    const { port, close } = await serve(log, () => {}, 0);
    await next();
    await close();
    await next();

    await expect(close()).rejects.toThrow(/ERR_SERVER_NOT_RUNNING|not running/);
    expect(await next()).toMatchObject({ event: "close", outcome: "error", port, error: expect.stringContaining("ERR_SERVER_NOT_RUNNING") });
  });

  it("writes a failed close's event only after the events of the requests it cut", async () => {
    const { log, next } = eventLog();
    const { port, close } = await serve(log, (_req, res) => res.writeHead(200).flushHeaders(), 0);
    await next();
    const res = await send(port, { path: "/" });

    const cut = expect(buffer(res)).rejects.toThrow(/aborted/);
    const closed = close();
    await expect(close()).rejects.toThrow(/ERR_SERVER_NOT_RUNNING|not running/);
    await closed;
    await cut;

    expect(await next()).toMatchObject({ event: "request", outcome: "stopped" });
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", requests_open: 1 });
    expect(await next()).toMatchObject({ event: "close", outcome: "error", requests_open: 1 });
  });

  // The port is held by a server that is not serve's, bound to LOOPBACK alone: on macOS a bind to the wildcard would
  // share it, and the connections dialed to LOOPBACK would reach the other server.
  it("records and rethrows a port another server holds on the loopback address", async () => {
    const port = await bare(LOOPBACK);
    const { log, next } = eventLog();

    await expect(serve(log, () => {}, port)).rejects.toThrow(/EADDRINUSE/);
    const listen = await next();
    expect(listen).toMatchObject({ event: "listen", outcome: "error", address: LOOPBACK, requested_port: port, error: expect.stringContaining("EADDRINUSE") });
    expect(listen).not.toHaveProperty("port");
  });

  // macOS lets the bind to LOOPBACK share a port held on the wildcard, where Linux refuses it; sharing, serve's is the
  // more specific bind, so it takes every connection dialed to LOOPBACK.
  it.runIf(process.platform === "darwin")("takes the connections dialed to LOOPBACK on a port another server holds on the wildcard", async () => {
    // The wildcard's port 0 can be one another process holds on LOOPBACK, which refuses serve's bind: the port is one
    // LOOPBACK's port 0 gave, so it is free there, held on the wildcard from then on.
    const free = createHttpServer().listen(0, LOOPBACK);
    await once(free, "listening");
    const { port: loopbackFree } = free.address() as AddressInfo;
    await new Promise((resolve) => free.close(resolve));
    const port = await bare(undefined, loopbackFree);
    const { close } = await serve(eventLog().log, (_req, res) => res.writeHead(204).end(), port);
    onTestFinished(close);

    expect((await send(port, { path: "/" })).statusCode).toBe(204);
  });
});

describe("serve with an upgrade", () => {
  // The client's side of an upgrade, raw: it asks to switch to a WebSocket and resolves once the server's first answer has
  // arrived, with the socket still open.
  async function upgradeTo(port: number) {
    const socket = createConnection(port, LOOPBACK);
    await once(socket, "connect");
    socket.write("GET /up HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    const [answer] = (await once(socket, "data")) as [Buffer];
    return { socket, answer: answer.toString() };
  }
  const switched = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";

  it("hands the part the connection and writes one event when its socket closes", async () => {
    // The part closes its side when the client closes its own, as a WebSocket's closing handshake ends.
    const { port, next } = await serving(
      () => {},
      async (_req, socket) => void socket.on("end", () => socket.end()).write(switched),
    );

    const { socket, answer } = await upgradeTo(port);
    const clientPort = socket.localPort;
    expect(answer).toContain("101 Switching Protocols");
    socket.end();

    expect(await next()).toMatchObject({
      event: "upgrade",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      outcome: "ok",
      url: "/up",
      protocol: "websocket",
      client_address: LOOPBACK,
      client_port: clientPort,
    });
  });

  it("records the failure the part reports", async () => {
    const { port, next } = await serving(
      () => {},
      async (_req, socket, _head, work) => {
        work.fail(new Error("refused"));
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      },
    );

    const { answer } = await upgradeTo(port);

    expect(answer).toContain("403");
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", error: expect.stringContaining("refused") });
  });

  it("waits for the part to be done with the connection, so a failure it learns of as the connection ends is the outcome", async () => {
    const { port, next } = await serving(
      () => {},
      async (_req, socket, _head, work) => {
        socket.on("end", () => socket.end()).write(switched);
        await once(socket, "close");
        work.fail(new Error("the peer broke the protocol"));
      },
    );

    const { socket } = await upgradeTo(port);
    socket.end();

    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", error: expect.stringContaining("the peer broke the protocol") });
  });

  it("records a connection its client reset, as its error and an upgrade aborted, and goes on serving", async () => {
    const handed = Promise.withResolvers<void>();
    const { port, next } = await serving(
      () => {},
      async (req, socket) => {
        if (req.url === "/up") return void socket.write(switched);
        handed.resolve();
      },
    );

    const socket = createConnection(port, LOOPBACK);
    await once(socket, "connect");
    socket.write("GET /reset HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await handed.promise;
    socket.resetAndDestroy();

    expect(await next()).toMatchObject({ event: "client_error", outcome: "error", error: expect.stringContaining("ECONNRESET") });
    expect(await next()).toMatchObject({ event: "upgrade", outcome: "aborted" });
    expect((await upgradeTo(port)).answer).toBe(switched);
  });

  it("cuts the connection of a part that throws, and records it", async () => {
    const { port, next } = await serving(
      () => {},
      () => {
        throw new Error("boom");
      },
    );

    const socket = createConnection(port, LOOPBACK);
    socket.end("GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    socket.resume();
    await once(socket, "close");

    expect(await next()).toMatchObject({ event: "upgrade", outcome: "error", error: expect.stringContaining("boom") });
  });

  it("cuts an upgraded connection still open when closed, and resolves once its event, ended as stopped, is written", async () => {
    const { log, next } = eventLog();
    const { port, close } = await serve(log, () => {}, 0, async (_req, socket) => void socket.write(switched));
    await next();
    const { socket } = await upgradeTo(port);

    const cut = once(socket, "close");
    await close();
    await cut;

    expect(await next()).toMatchObject({ event: "upgrade", outcome: "stopped" });
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", port, requests_open: 0, upgrades_open: 1 });
  });

  it("hands an upgrade request to the handler, as any other request, when the part takes no upgrades", async () => {
    const { port, next } = await serving((_req, res) => res.writeHead(426).end());

    const { answer } = await upgradeTo(port);

    expect(answer).toContain("426");
    expect(await next()).toMatchObject({ event: "request", status: 426 });
  });

  it("hands a request offering any other upgrade to the handler, as any other request, when the part takes upgrades", async () => {
    const upgrades: string[] = [];
    const { port, next } = await serving(
      (_req, res) => res.writeHead(204).end(),
      async (req, socket) => void (upgrades.push(req.url!), socket.destroy()),
    );

    const socket = createConnection(port, LOOPBACK);
    await once(socket, "connect");
    socket.write("POST /launch HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAARAAAAAAAIAAAAA\r\nContent-Length: 0\r\n\r\n");
    const [answer] = (await once(socket, "data")) as [Buffer];
    socket.destroy();

    expect(answer.toString()).toContain("204");
    expect(await next()).toMatchObject({ event: "request", method: "POST", url: "/launch", status: 204 });
    expect(upgrades).toEqual([]);
  });
});
