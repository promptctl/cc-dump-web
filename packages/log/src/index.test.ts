import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createLog, listen, withRequestEvent, type Event, type Handler } from "./index.ts";
import { closedAfterTest, eventLog } from "./testing.ts";

async function serve(handler: Handler) {
  const { log, next } = eventLog();
  const port = await listen(() => {}, closedAfterTest(createServer(withRequestEvent(log, handler))), 0);
  return { url: `http://127.0.0.1:${port}`, next };
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
});

describe("listen", () => {
  it("records the port it bound", async () => {
    const { log, next } = eventLog();

    const port = await listen(log, closedAfterTest(createServer()), 0);

    expect(await next()).toMatchObject({ event: "listen", outcome: "ok", port });
  });

  it("records and rethrows a port that is already taken", async () => {
    const port = await listen(() => {}, closedAfterTest(createServer()), 0);
    const { log, next } = eventLog();

    await expect(listen(log, createServer(), port)).rejects.toThrow(/EADDRINUSE/);
    expect(await next()).toMatchObject({ event: "listen", outcome: "error", port, error: expect.stringContaining("EADDRINUSE") });
  });
});
