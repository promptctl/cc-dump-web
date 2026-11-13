import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { buffer } from "node:stream/consumers";
import { setTimeout } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it, onTestFinished } from "vitest";
import { createLog, logged, serve, type Event, type Work } from "./index.ts";
import { eventLog, send, sendRaw, serving } from "./testing.ts";

const ended: Event = { event: "e", trace_id: "t", started_at: "s", duration_ms: 0, outcome: "ok" };

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
});

describe("serve", () => {
  it("emits one event for an answered request", async () => {
    const { url, next } = await serving((_req, res) => res.writeHead(418).end());

    await (await fetch(`${url}/a?b=1`, { method: "POST" })).text();

    expect(await next()).toMatchObject({
      event: "request",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      started_at: expect.any(String),
      duration_ms: expect.any(Number),
      outcome: "ok",
      method: "POST",
      url: "/a?b=1",
      status: 418,
      client_address: expect.stringContaining("127.0.0.1"),
      client_port: expect.any(Number),
    });
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

    const bare = createHttpServer().listen(0);
    onTestFinished(() => new Promise<void>((resolve) => bare.close(() => resolve())));
    await once(bare, "listening");
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
    expect(reply).toBe((await sendRaw((bare.address() as AddressInfo).port, "NOT HTTP\r\n\r\n")).reply);
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

    const socket = createConnection(port, "127.0.0.1");
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
  it("records the port it bound and closing it", async () => {
    const { log, next } = eventLog();

    const { port, close } = await serve(log, () => {}, 0);
    await close();

    expect(await next()).toMatchObject({ event: "listen", outcome: "ok", port });
    expect(await next()).toMatchObject({ event: "close", outcome: "ok", port, requests_open: 0 });
  });

  it("cuts a request still open when closed, and resolves once its event, ended as stopped, is written", async () => {
    const { log, next } = eventLog();
    const { port, close } = await serve(log, (_req, res) => res.writeHead(200).flushHeaders(), 0);
    await next();
    const res = await send(port, { path: "/" });

    const cut = expect(buffer(res)).rejects.toThrow(/aborted/);
    await close();
    await cut;

    expect(await next()).toMatchObject({ event: "request", outcome: "stopped", status: 200 });
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

  it("records and rethrows a port that is already taken", async () => {
    const { port } = await serving(() => {});
    const { log, next } = eventLog();

    await expect(serve(log, () => {}, port)).rejects.toThrow(/EADDRINUSE/);
    expect(await next()).toMatchObject({ event: "listen", outcome: "error", port, error: expect.stringContaining("EADDRINUSE") });
  });
});
