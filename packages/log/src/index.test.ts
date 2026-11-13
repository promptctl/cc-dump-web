import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLog, listen, withRequestEvent, type Event } from "./index.ts";

// A log the test can wait on: `next()` resolves with the next event written.
function eventLog() {
  const written: Event[] = [];
  const waiting: ((event: Event) => void)[] = [];
  return {
    log: (event: Event) => {
      const waiter = waiting.shift();
      if (waiter) waiter(event);
      else written.push(event);
    },
    next: () => new Promise<Event>((resolve) => (written.length ? resolve(written.shift()!) : waiting.push(resolve))),
  };
}

const open: Server[] = [];
afterEach(() => Promise.all(open.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))));

async function serve(handler: RequestListener) {
  const { log, next } = eventLog();
  const server = createServer(withRequestEvent(log, handler));
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, next };
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

describe("withRequestEvent", () => {
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
});

describe("listen", () => {
  it("records the port it bound", async () => {
    const { log, next } = eventLog();
    const server = createServer();
    open.push(server);

    await listen(log, server, 0);

    expect(await next()).toMatchObject({ event: "listen", outcome: "ok", port: (server.address() as AddressInfo).port });
  });

  it("records and rethrows a port that is already taken", async () => {
    const taken = createServer();
    open.push(taken);
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    const { port } = taken.address() as AddressInfo;
    const { log, next } = eventLog();

    await expect(listen(log, createServer(), port)).rejects.toThrow(/EADDRINUSE/);
    expect(await next()).toMatchObject({ event: "listen", outcome: "error", port, error: expect.stringContaining("EADDRINUSE") });
  });
});
