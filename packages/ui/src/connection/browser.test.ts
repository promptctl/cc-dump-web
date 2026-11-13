import type { RecordedEvent, RecordingEnd } from "@cc-dump/proxy/format";
import { proxyProcess } from "@cc-dump/proxy/testing";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import type { Event } from "@cc-dump/log";
import { send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
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
  const arrived: Arrival[] = [];
  const waiting: ((arrival: Arrival) => void)[] = [];
  const arrive = (arrival: Arrival) => (waiting.length ? waiting.shift()!(arrival) : arrived.push(arrival));
  connection.read(name, { event: (event) => arrive({ event }), end: (end) => arrive({ end }), failed: (failed) => arrive({ failed }) }, abort.signal);
  return {
    abort,
    next: () => new Promise<Arrival>((resolve) => (arrived.length ? resolve(arrived.shift()!) : waiting.push(resolve))),
    queued: () => arrived.length,
  };
}

describe("the browser connection", () => {
  it("lists the recordings, oldest first, the live one marked", async () => {
    const { connection } = await proxyAndConnection();
    expect(await connection.recordings(new AbortController().signal)).toEqual([
      { name: finishedName, live: false },
      { name: liveName, live: true },
    ]);
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
});
