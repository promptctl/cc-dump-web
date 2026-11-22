import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { serve } from "@cc-dump/log";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { LOOPBACK } from "@cc-dump/log/address";
import { nextRequestEvent, send, serving, subscribe } from "@cc-dump/log/testing";
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
    const failed = nextRequestEvent(next);
    const answered = fetch(`http://${LOOPBACK}:${proxyPort}/v1/messages`, { method: "POST", body: "{}" });
    expect(await failed).toMatchObject({ service: "proxy", event: "request", outcome: "error", error: expect.stringContaining("ECONNREFUSED"), facts: { method: "POST", url: "/v1/messages", status: 502 } });
    expect((await answered).status).toBe(502);
  });

  it("logs each request the reader port refuses as failed, in the refusal's words", async () => {
    const { readerPort } = await proxy();
    const { res, next } = await subscribe(readerPort, "/logs");
    onTestFinished(() => void res.destroy());

    const refused = [await send(readerPort, { path: "/elsewhere" }), await send(readerPort, { method: "POST", path: "/logs" })];

    expect(refused.map(({ statusCode }) => statusCode)).toEqual([404, 405]);
    expect(await nextRequestEvent(next)).toMatchObject({ outcome: "error", error: expect.stringContaining("Nothing is served at /elsewhere"), facts: { url: "/elsewhere", status: 404 } });
    expect(await nextRequestEvent(next)).toMatchObject({ outcome: "error", error: expect.stringContaining("POST is not taken at /logs; it takes GET"), facts: { method: "POST", url: "/logs", status: 405 } });
    for (const answer of refused) answer.destroy();
  });

  it("makes a new agent's recording, answering its name, and lists none until it holds something", async () => {
    const { dir, readerPort } = await proxy();

    const res = await send(readerPort, { method: "POST", path: "/recordings" });
    const { name } = parseListing((await buffer(res)).toString());

    expect([res.statusCode, res.headers["content-type"]]).toEqual([200, "application/json"]);
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

  it("answers a page of the UI's origin, and refuses a foreign page and a foreign Host, as the app server does", async () => {
    const { readerPort } = await proxy();
    const ui = "http://127.0.0.1:3346";
    const answered = async (headers: Record<string, string>) => {
      const res = await send(readerPort, { path: "/info", headers });
      res.resume();
      return [res.statusCode, res.headers["access-control-allow-origin"], res.headers.vary];
    };
    expect(await answered({ origin: ui })).toEqual([200, ui, "origin"]);
    expect(await answered({ origin: "https://example.com" })).toEqual([403, undefined, "origin"]);
    expect(await answered({ host: "evil.example" })).toEqual([403, undefined, "origin"]);
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
