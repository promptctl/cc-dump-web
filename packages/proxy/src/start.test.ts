import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { serve } from "@cc-dump/log";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { LOOPBACK } from "@cc-dump/log/address";
import { parseLogLine } from "@cc-dump/log/line";
import { send, serving, subscribe } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseListing, parseListings, parseProxyInfo, parseProxyStatus, recordingStart } from "./format.ts";
import { proxyProcess } from "./testing.ts";

describe("the reader port", () => {
  const proxy = async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const upstream = await serving((_req, res) => res.end());
    return { dir, upstream: upstream.url, ...(await proxyProcess(upstream.url, dir, "unlimited")) };
  };

  it("serves the recordings and the proxy's status, info and log, every answer to any origin", async () => {
    const { readerPort } = await proxy();
    const answers = await Promise.all(["/recordings", "/status", "/info", "/logs", "/elsewhere"].map((path) => send(readerPort, { path })));
    expect(answers.map((res) => [res.statusCode, res.headers["content-type"], res.headers["access-control-allow-origin"]])).toEqual([
      [200, "application/json", "*"],
      [200, "text/event-stream", "*"],
      [200, "application/json", "*"],
      [200, "text/event-stream", "*"],
      [404, undefined, "*"],
    ]);
    for (const res of answers) res.destroy();
  });

  it("sends a request its upstream cannot be reached for to its log's readers, as it fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // A port nothing listens on: bound, then let go.
    const bound = await serve(() => {}, (_req, res) => res.end(), 0);
    await bound.close();
    const { proxyPort, readerPort } = await proxyProcess(`http://${LOOPBACK}:${bound.port}`, dir, "unlimited");
    const { res, next } = await subscribe(readerPort, "/logs");
    onTestFinished(() => void res.destroy());
    // The lines of the proxy's start come first; the request's comes once it has failed.
    const failed = (async () => {
      for (;;) {
        const { data, id } = await next();
        const line = parseLogLine(data, id!);
        if ("event" in line && line.event.event === "request") return line.event;
      }
    })();
    void fetch(`http://${LOOPBACK}:${proxyPort}/v1/messages`, { method: "POST", body: "{}" }).then((res) => res.text());
    expect(await failed).toMatchObject({ service: "proxy", event: "request", outcome: "error", error: expect.stringContaining("ECONNREFUSED"), facts: { method: "POST", url: "/v1/messages" } });
  });

  it("makes a recording for an agent about to launch, answering its name, and lists none until it holds something", async () => {
    const { dir, readerPort } = await proxy();

    const res = await send(readerPort, { method: "POST", path: "/recordings" });
    const { name } = parseListing((await buffer(res)).toString());

    expect([res.statusCode, res.headers["content-type"], res.headers["access-control-allow-origin"]]).toEqual([200, "application/json", "*"]);
    expect(recordingStart(name)).toBeInstanceOf(Date);
    expect(readFileSync(join(dir, name), "utf8")).toBe("");
    const listed = await send(readerPort, { path: "/recordings" });
    expect(parseListings((await buffer(listed)).toString())).toEqual([]);
  });

  it("makes each recording its own, though asked within one millisecond", async () => {
    const { readerPort } = await proxy();
    const names = await Promise.all(
      Array.from({ length: 5 }, async () => parseListing((await buffer(await send(readerPort, { method: "POST", path: "/recordings" }))).toString()).name),
    );
    expect(new Set(names).size).toBe(5);
  });

  it("refuses the other methods of the list, naming those it takes", async () => {
    const { readerPort } = await proxy();
    const res = await send(readerPort, { method: "PUT", path: "/recordings" });
    expect([res.statusCode, res.headers.allow]).toEqual([405, "GET, POST"]);
    res.destroy();
  });

  it("gives agents the address of the port the proxy bound, and says where it forwards to and where it records, at /info and in its status", async () => {
    const { dir, proxyPort, readerPort, upstream } = await proxy();
    const info = { base_url: `http://${LOOPBACK}:${proxyPort}`, upstream: `${upstream}/`, recordings: dir };
    expect(parseProxyInfo((await buffer(await send(readerPort, { path: "/info" }))).toString())).toEqual(info);
    const { res, next } = await subscribe(readerPort, "/status");
    onTestFinished(() => void res.destroy());
    expect(parseProxyStatus((await next()).data).info).toEqual(info);
  });

  it("sends the traffic in its status: a request in flight until it ends, and when it arrived", async () => {
    const held = Promise.withResolvers<void>();
    const upstream = await serving((_req, res) => void held.promise.then(() => res.end()));
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const { proxyPort, readerPort } = await proxyProcess(upstream.url, dir, "unlimited");
    const { res, next } = await subscribe(readerPort, "/status");
    onTestFinished(() => void res.destroy());
    const traffic = async () => parseProxyStatus((await next()).data).traffic;
    expect(await traffic()).toEqual({ in_flight: 0, last_request: null });

    const before = Date.now();
    const answered = send(proxyPort, { path: "/v1/messages" });
    const arrived = await traffic();
    expect(arrived.in_flight).toBe(1);
    expect(Date.parse(arrived.last_request!)).toBeGreaterThanOrEqual(before - 1);
    held.resolve();
    (await answered).resume();
    expect(await traffic()).toEqual({ in_flight: 0, last_request: arrived.last_request });
  });
});
