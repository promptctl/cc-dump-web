import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { setTimeout } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createLog, createServer, listen, type Event, type Handler } from "./index.ts";
import { closedAfterTest, eventLog, sendRaw } from "./testing.ts";

async function serve(handler: Handler) {
  const { log, next } = eventLog();
  const port = await listen(() => {}, closedAfterTest(createServer(log, handler)), 0);
  return { port, url: `http://127.0.0.1:${port}`, next };
}

const ended: Event = { event: "e", trace_id: "t", started_at: "s", duration_ms: 0, outcome: "ok" };

// @ts-expect-error An event that ended well cannot carry an error.
const contradictory: Event = { ...ended, error: "boom" };
void contradictory;

describe("createLog", () => {
  it("writes each event as one JSON line naming its service", () => {
    const lines: string[] = [];
    createLog("proxy", (line) => lines.push(line))({ ...ended, port: 1 });

    expect(lines).toEqual([`${JSON.stringify({ service: "proxy", ...ended, port: 1 })}\n`]);
  });
});

describe("createServer", () => {
  it("emits one event for an answered request", async () => {
    const { url, next } = await serve((_req, res) => res.writeHead(418).end());

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
    const { url, next } = await serve(() => arrived());

    const abort = new AbortController();
    const request = fetch(url, { signal: abort.signal }).catch(() => "aborted");
    await received;
    abort.abort();

    expect(await request).toBe("aborted");
    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", status: null });
  });

  it("records the first failure the handler reports, beside the answer it sent", async () => {
    const { url, next } = await serve((_req, res, fail) => {
      fail(new Error("first"));
      fail(new Error("second"));
      res.writeHead(502).end();
    });

    await (await fetch(url)).text();

    const event = await next();
    expect(event).toMatchObject({ event: "request", outcome: "error", status: 502, error: expect.stringContaining("first") });
    expect(event.error).not.toContain("second");
  });

  it("records a request node refuses before any handler, and leaves node's answer as node sent it", async () => {
    const { port, next } = await serve(() => expect.unreachable("no handler sees a malformed request"));

    const { reply, clientPort } = await sendRaw(port, "NOT HTTP\r\n\r\n");

    expect(reply).toBe("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    expect(await next()).toMatchObject({
      event: "client_error",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      outcome: "error",
      error: expect.stringContaining("HPE_INVALID_METHOD"),
      client_port: clientPort,
    });
  });

  it("spans a connection error from the moment the connection opened", async () => {
    const { port, next } = await serve(() => expect.unreachable("no handler sees a malformed request"));

    const socket = createConnection(port, "127.0.0.1");
    await once(socket, "connect");
    await setTimeout(100);
    socket.end("NOT HTTP\r\n\r\n").resume();

    expect((await next()).duration_ms).toBeGreaterThan(50);
  });

  it("records a connection error beside the request it cut, joined by the client's port", async () => {
    const { port, next } = await serve((req, res) => {
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
});

describe("listen", () => {
  it("records the port it bound", async () => {
    const { log, next } = eventLog();

    const port = await listen(log, closedAfterTest(createHttpServer()), 0);

    expect(await next()).toMatchObject({ event: "listen", outcome: "ok", port });
  });

  it("records and rethrows a port that is already taken", async () => {
    const port = await listen(() => {}, closedAfterTest(createHttpServer()), 0);
    const { log, next } = eventLog();

    await expect(listen(log, createHttpServer(), port)).rejects.toThrow(/EADDRINUSE/);
    expect(await next()).toMatchObject({ event: "listen", outcome: "error", port, error: expect.stringContaining("EADDRINUSE") });
  });
});
