import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import { gzipSync } from "node:zlib";
import type { Event, Handler } from "@cc-dump/log";
import { LOOPBACK } from "@cc-dump/log/address";
import { eventLog, send, sendRaw, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { createProxy, parseUpstream } from "./proxy.ts";
import { agentBaseUrl, recordingName, type RecordedEvent } from "./format.ts";
import { createRecordings } from "./recordings.ts";
import { proxyProcess, runName } from "./testing.ts";

async function upstreamServing(handler: Handler): Promise<URL> {
  return new URL((await serving(handler)).url);
}

// Nothing listens on port 1. localhost, because it resolves to more than one address on most
// hosts, and refusal by all of them is an AggregateError.
const refusingAddress = new URL("http://localhost:1");

// A recordings directory in a fresh directory, removed when the test finishes. `path` is the run's recording, where the
// traffic no agent claims is recorded; `events` reads a recording back, the run's unless another is named.
function recordingsDir() {
  const root = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "recordings");
  const events = (name = runName) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordedEvent);
  return { dir, path: join(dir, runName), events };
}

// The proxy, recording into a fresh directory. The recordings' own events go to `recordLog`.
async function proxyTo(upstream: URL) {
  const { dir, path, events } = recordingsDir();
  const recordLog = eventLog();
  return { ...(await serving(createProxy(parseUpstream(upstream.href), createRecordings(recordLog.log, dir, runName)))), dir, path, events, recordLog };
}

const bodyOf = (events: RecordedEvent[], type: "request_body" | "response_body") =>
  Buffer.concat(events.flatMap((event) => (event.type === type ? [Buffer.from(event.base64, "base64")] : [])));

// The event types in order, a run of one type as one entry: how a body is chunked is the network's.
const shape = (events: RecordedEvent[]) => events.map(({ type }) => type).filter((type, i, types) => type !== types[i - 1]);

function pairs(rawHeaders: string[]): [string, string][] {
  return rawHeaders.flatMap((name, i): [string, string][] => (i % 2 ? [] : [[name, rawHeaders[i + 1]!]]));
}

// The proxy's request of the upstream for `path`, closed: node's client announces each request it starts, and its close
// is subscribed to as it does.
function upstreamRequestClosed(path: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const started = (message: unknown) => {
    const { request } = message as { request: ClientRequest };
    if (request.path === path) request.once("close", () => resolve());
  };
  subscribe("http.client.request.start", started);
  onTestFinished(() => void unsubscribe("http.client.request.start", started));
  return promise;
}

// The cut the agent's leaving makes upstream is the request's ending, which its event has, and no failure. node reports
// the cut as the proxy's upstream request closes: one with no response yet hangs up as it closes, and the response of
// one that has one is aborted on the tick queue after, which node drains before the close's promise resolves. Past
// both, the next event is the close of the proxy's server.
async function theCutIsNoFailure(upstreamClosed: Promise<void>, next: () => Promise<Event>, close: () => Promise<void>) {
  await upstreamClosed;
  await close();
  expect(await next()).toMatchObject({ event: "close", requests_open: 0 });
}

describe("createProxy", () => {
  const body = Buffer.from([0x00, 0xff, 0x80, 0x7b, 0x0a, 0xc3]);

  it.each([
    { method: "POST", path: "/v1/messages?beta=true", framing: { "content-length": String(body.length) } },
    { method: "GET", path: "/v1/models?limit=1", framing: { "content-length": String(body.length) } },
    { method: "GET", path: "/v1/models", framing: { "transfer-encoding": "chunked" } },
  ])("forwards $method $path with its body byte-for-byte, framed by $framing", async ({ method, path, framing }) => {
    let received!: { method: string | undefined; url: string | undefined; headers: [string, string][]; body: Buffer };
    const upstream = await upstreamServing(async (req, res) => {
      received = { method: req.method, url: req.url, headers: pairs(req.rawHeaders), body: await buffer(req) };
      res.end();
    });
    const { port } = await proxyTo(upstream);

    const res = await send(port, {
      method,
      path,
      headers: { "x-api-key": "sk-test", "X-Custom": "a", connection: "x-hop", "x-hop": "1", ...framing },
      body,
    });
    await buffer(res);

    expect(received.method).toBe(method);
    expect(received.url).toBe(path);
    expect(received.body.equals(body)).toBe(true);
    expect(received.headers).toContainEqual(["x-api-key", "sk-test"]);
    expect(received.headers).toContainEqual(["X-Custom", "a"]);
    expect(received.headers.filter(([name]) => name.toLowerCase() === "host")).toEqual([["host", upstream.host]]);
    expect(received.headers.map(([name]) => name)).not.toContain("x-hop");
  });

  it("returns the upstream's status, headers and body bytes unchanged", async () => {
    const compressed = gzipSync('{"type":"message"}');
    const upstream = await upstreamServing((_req, res) => {
      res.writeHead(529, "Overloaded", ["Content-Encoding", "gzip", "Set-Cookie", "a=1", "Set-Cookie", "b=2"]);
      res.end(compressed);
    });
    const { port } = await proxyTo(upstream);

    const res = await send(port, { path: "/v1/messages" });

    expect(res.statusCode).toBe(529);
    expect(res.statusMessage).toBe("Overloaded");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect((await buffer(res)).equals(compressed)).toBe(true);
  });

  it("logs a request the upstream answered with an error as failed, by the status line relayed, and records its exchange as ended", async () => {
    const upstream = await upstreamServing((_req, res) => res.writeHead(529, "Overloaded").end('{"type":"error"}'));
    const { port, next, events } = await proxyTo(upstream);

    await buffer(await send(port, { method: "POST", path: "/v1/messages" }));

    expect(await next()).toMatchObject({ event: "request", outcome: "error", error: "529 Overloaded", status: 529 });
    expect(events().at(-1)).toMatchObject({ type: "end", outcome: "ok" });
  });

  it("delivers each streamed chunk before upstream sends the next", async () => {
    let firstArrived!: () => void;
    const agentHasFirst = new Promise<void>((resolve) => (firstArrived = resolve));
    const upstream = await upstreamServing(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n\n");
      await agentHasFirst;
      res.end("event: message_stop\n\n");
    });
    const { port, next } = await proxyTo(upstream);

    const res = await send(port, { method: "POST", path: "/v1/messages" });
    const [first] = (await once(res, "data")) as [Buffer];
    firstArrived();

    expect(first.toString()).toBe("event: message_start\n\n");
    expect((await buffer(res)).toString()).toBe("event: message_stop\n\n");
    expect(await next()).toMatchObject({ event: "request", outcome: "ok", status: 200 });
  });

  it("answers 502 in the API's error shape when the upstream cannot be reached", async () => {
    const { port, next } = await proxyTo(refusingAddress);

    const res = await send(port, { method: "POST", path: "/v1/messages" });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse((await buffer(res)).toString())).toMatchObject({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(await next()).toMatchObject({ outcome: "error", status: 502, error: expect.stringContaining("ECONNREFUSED") });
  });

  // Status lines node's response parser accepts and writeHead refuses.
  it.each([
    { statusLine: "HTTP/1.1 099 Early", code: "ERR_HTTP_INVALID_STATUS_CODE" },
    { statusLine: "HTTP/1.1 200 O\x7fK", code: "ERR_INVALID_CHAR" },
  ])("cuts the agent's response when upstream answers $statusLine, which node cannot relay", async ({ statusLine, code }) => {
    const upstream = await upstreamServing((req) => req.socket.end(`${statusLine}\r\ncontent-length: 2\r\n\r\nok`));
    const { port, next } = await proxyTo(upstream);

    await expect(send(port, { method: "POST", path: "/v1/messages" })).rejects.toThrow(/socket hang up/);
    expect(await next()).toMatchObject({ outcome: "error", status: null, error: expect.stringContaining(code) });
  });

  it("frames the response for the agent's HTTP version", async () => {
    const upstream = await upstreamServing((_req, res) => {
      res.write("hel");
      res.end("lo");
    });
    const { port } = await proxyTo(upstream);

    const agent = createConnection(port, LOOPBACK);
    agent.write("GET /v1/models HTTP/1.0\r\n\r\n");
    const [, body] = (await buffer(agent)).toString().split("\r\n\r\n");

    expect(body).toBe("hello");
  });

  it("cuts the agent's response when the upstream cuts mid-stream", async () => {
    const upstream = await upstreamServing((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n\n", () => req.socket.destroy());
    });
    const { port, next } = await proxyTo(upstream);

    const res = await send(port, { method: "POST", path: "/v1/messages" });

    await expect(buffer(res)).rejects.toThrow(/aborted/);
    expect(await next()).toMatchObject({ outcome: "error", status: 200 });
  });

  it("closes the upstream request when the agent leaves", async () => {
    let upstreamClosed!: () => void;
    const closedUpstream = new Promise<void>((resolve) => (upstreamClosed = resolve));
    const upstream = await upstreamServing((_req, res) => {
      res.on("close", upstreamClosed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\n\n");
    });
    const cut = upstreamRequestClosed("/upstream/v1/messages");
    const { port, next, close } = await proxyTo(new URL("/upstream", upstream));

    const res = await send(port, { method: "POST", path: "/v1/messages" });
    await once(res, "data");
    res.destroy();

    await closedUpstream;
    expect(await next()).toMatchObject({ outcome: "aborted" });
    await theCutIsNoFailure(cut, next, close);
  });

  it("closes the upstream request when the agent leaves before the response starts", async () => {
    let upstreamClosed!: () => void;
    const closedUpstream = new Promise<void>((resolve) => (upstreamClosed = resolve));
    let requestArrived!: () => void;
    const arrived = new Promise<void>((resolve) => (requestArrived = resolve));
    const upstream = await upstreamServing((_req, res) => {
      res.on("close", upstreamClosed);
      requestArrived();
    });
    const cut = upstreamRequestClosed("/upstream/v1/messages");
    const { port, next, close } = await proxyTo(new URL("/upstream", upstream));

    const req = request({ host: LOOPBACK, port, method: "POST", path: "/v1/messages" });
    const hungUp = once(req, "error");
    req.end();
    await arrived;
    req.destroy();

    await expect(hungUp).resolves.toEqual([expect.objectContaining({ code: "ECONNRESET" })]);
    await closedUpstream;
    expect(await next()).toMatchObject({ outcome: "aborted" });
    await theCutIsNoFailure(cut, next, close);
  });

  // llhttp's parse errors carry the bytes they were parsing as rawPacket, on either side of the proxy.
  it("answers oversized request headers with node's 431 and logs it without the request's bytes", async () => {
    const { port, next } = await proxyTo(refusingAddress);

    const { reply, clientPort } = await sendRaw(port, `GET / HTTP/1.1\r\nx-api-key: sk-test\r\nx-big: ${"a".repeat(20_000)}\r\n\r\n`);

    expect(reply).toMatch(/^HTTP\/1\.1 431 /);
    const event = await next();
    expect(event).toMatchObject({ event: "client_error", outcome: "error", error: expect.stringContaining("HPE_HEADER_OVERFLOW"), client_port: clientPort });
    expect(event.error).not.toContain("rawPacket");
  });

  it("answers 502 to an upstream response node cannot parse and logs it without the response's bytes", async () => {
    const upstream = await upstreamServing((req) => req.socket.end("HTTP/1.1 200 OK\r\nset-cookie: session=1\r\nbad header\r\n\r\n"));
    const { port, next } = await proxyTo(upstream);

    const res = await send(port, { method: "POST", path: "/v1/messages" });

    expect(res.statusCode).toBe(502);
    const event = await next();
    expect(event).toMatchObject({ event: "request", outcome: "error", status: 502, error: expect.stringContaining("HPE_INVALID_HEADER_TOKEN") });
    expect(event.error).not.toContain("rawPacket");
  });

  it.each(["ftp://example.com", "https://gw.example/anthropic?key=1", "https://user:pw@gw.example", "https://gw.example/#a", "gw.example", ""])(
    "refuses the upstream %j, which it could not forward to as given, without repeating it",
    (value) => {
      expect(() => parseUpstream(value)).toThrow(/^is not an http or https origin with an optional path$/);
    },
  );

  it.each(["https://api.anthropic.com", "http://127.0.0.1:8080/anthropic/"])("takes the upstream %s, as its href", (text) => {
    expect(parseUpstream(text)).toBe(new URL(text).href);
  });

  describe("recording", () => {
    it("records the request and response as they were on the wire, ending as the log event does", async () => {
      const upstream = await upstreamServing(async (req, res) => {
        await buffer(req);
        res.writeHead(200, "Fine", ["Content-Type", "text/event-stream"]);
        res.write("event: message_start\n\n");
        res.end("event: message_stop\n\n");
      });
      const { port, next, events } = await proxyTo(upstream);

      const res = await send(port, {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: { "X-Custom": "a", "content-length": String(body.length) },
        body,
      });
      await buffer(res);
      const logged = await next();

      const recorded = events();
      expect(shape(recorded)).toEqual(["request", "request_body", "request_trailers", "response", "response_body", "response_trailers", "end"]);
      expect(new Set(recorded.map(({ trace_id }) => trace_id))).toEqual(new Set([logged.trace_id]));
      for (const { timestamp } of recorded) expect(new Date(timestamp).toISOString()).toBe(timestamp);
      expect(recorded[0]).toMatchObject({
        method: "POST",
        url: "/v1/messages?beta=true",
        http_version: "1.1",
        headers: expect.arrayContaining([["X-Custom", "a"]]),
      });
      expect(recorded.find(({ type }) => type === "response")).toMatchObject({
        status: 200,
        reason: "Fine",
        http_version: "1.1",
        headers: expect.arrayContaining([["Content-Type", "text/event-stream"]]),
      });
      expect(bodyOf(recorded, "request_body").equals(body)).toBe(true);
      expect(bodyOf(recorded, "response_body").toString()).toBe("event: message_start\n\nevent: message_stop\n\n");
      expect(recorded.at(-1)).toEqual({ type: "end", outcome: "ok", timestamp: expect.any(String), trace_id: logged.trace_id });
    });

    it("records each agent's requests in its own recording, forwarded without the path that names it, and the rest in the run's, forwarded as sent", async () => {
      const received: (string | undefined)[] = [];
      const upstream = await upstreamServing((req, res) => {
        received.push(req.url);
        res.end("answer");
      });
      const { port, next, dir, events } = await proxyTo(upstream);
      const [first, second] = [recordingName(new Date("2026-11-15T00:42:15.438Z")), recordingName(new Date("2026-11-15T00:43:00.000Z"))];
      const requests = [
        { path: `${agentBaseUrl("", first)}/v1/messages?beta=true`, to: first, as: "/v1/messages?beta=true" },
        { path: `${agentBaseUrl("", second)}/v1/models`, to: second, as: "/v1/models" },
        { path: `${agentBaseUrl("", first)}/api/hello`, to: first, as: "/api/hello" },
        // The base URL itself is the upstream's root.
        { path: agentBaseUrl("", second), to: second, as: "/" },
        { path: `${agentBaseUrl("", first)}?x=1`, to: first, as: "/?x=1" },
        { path: "/v1/models", to: runName, as: "/v1/models" },
        // A stem that is no recording's name names no agent.
        { path: "/agent/notes/v1/models", to: runName, as: "/agent/notes/v1/models" },
      ];

      for (const { path } of requests) {
        await buffer(await send(port, { path }));
        await next();
      }

      expect(received).toEqual(requests.map(({ as }) => as));
      expect(readdirSync(dir).sort()).toEqual([first, second, runName].sort());
      for (const name of [first, second, runName]) {
        const wanted = requests.filter(({ to }) => to === name).map(({ as }) => as);
        expect(events(name).flatMap((event) => (event.type === "request" ? [event.url] : []))).toEqual(wanted);
      }
    });

    it("logs each exchange's recording as its own event in the exchange's trace, counting what it wrote", async () => {
      const upstream = await upstreamServing((_req, res) => res.end("answer"));
      const { port, next, path, recordLog } = await proxyTo(upstream);

      await buffer(await send(port, { path: "/v1/models" }));
      const exchange = await next();

      expect(await recordLog.next()).toEqual({
        event: "record",
        trace_id: exchange.trace_id,
        started_at: expect.any(String),
        duration_ms: expect.any(Number),
        outcome: "ok",
        path,
        counts: { events_written: readFileSync(path, "utf8").split("\n").length - 1, bytes_written: readFileSync(path).length, events_failed: 0 },
      });
    });

    it("forwards credentials in both directions and never writes them", async () => {
      let received!: [string, string][];
      const upstream = await upstreamServing((req, res) => {
        received = pairs(req.rawHeaders);
        res.writeHead(200, ["Set-Cookie", "session=s3"]).end();
      });
      const { port, next, path } = await proxyTo(upstream);
      const credentials = { Authorization: "Bearer sk-a1", "Proxy-Authorization": "Basic proxy-p4", "x-api-key": "sk-b2", cookie: "c=c3" };

      const res = await send(port, { path: "/v1/models", headers: credentials });
      await buffer(res);
      await next();

      expect(received).toEqual(expect.arrayContaining(Object.entries(credentials)));
      expect(res.headers["set-cookie"]).toEqual(["session=s3"]);
      const file = readFileSync(path, "utf8");
      for (const value of ["sk-a1", "proxy-p4", "sk-b2", "c=c3", "session=s3"]) expect(file).not.toContain(value);
    });

    it("forwards trailers in both directions and records them after the body they end, without credentials", async () => {
      let received!: [string, string][];
      const upstream = await upstreamServing(async (req, res) => {
        await buffer(req);
        received = pairs(req.rawTrailers);
        res.writeHead(200, { trailer: "x-checksum" });
        res.write("answer");
        res.addTrailers([["x-checksum", "c1"], ["Set-Cookie", "session=s3"]]);
        res.end();
      });
      const { port, next, events } = await proxyTo(upstream);

      const req = request({
        host: LOOPBACK,
        port,
        method: "POST",
        path: "/v1/messages",
        headers: { "transfer-encoding": "chunked", trailer: "x-sent" },
      });
      req.write("asking");
      req.addTrailers([["x-sent", "s1"], ["Authorization", "Bearer sk-a1"]]);
      req.end();
      const [res] = (await once(req, "response")) as [IncomingMessage];
      await buffer(res);
      await next();

      expect(received).toEqual([["x-sent", "s1"], ["Authorization", "Bearer sk-a1"]]);
      expect(pairs(res.rawTrailers)).toEqual([["x-checksum", "c1"], ["Set-Cookie", "session=s3"]]);
      expect(shape(events())).toEqual(["request", "request_body", "request_trailers", "response", "response_body", "response_trailers", "end"]);
      expect(events().find(({ type }) => type === "request_trailers")).toMatchObject({ headers: [["x-sent", "s1"]] });
      expect(events().find(({ type }) => type === "response_trailers")).toMatchObject({ headers: [["x-checksum", "c1"]] });
    });

    it("keeps overlapping requests apart as separate exchanges", async () => {
      let arrived = 0;
      let bothArrived!: () => void;
      const both = new Promise<void>((resolve) => (bothArrived = resolve));
      const upstream = await upstreamServing(async (req, res) => {
        await buffer(req);
        if (++arrived === 2) bothArrived();
        await both;
        res.end(`answer to ${req.url}`);
      });
      const { port, next, events } = await proxyTo(upstream);

      await Promise.all(
        ["/v1/messages?n=1", "/v1/messages?n=2"].map(async (path) => {
          const asked = Buffer.from(`asking ${path}`);
          await buffer(await send(port, { method: "POST", path, headers: { "content-length": String(asked.length) }, body: asked }));
        }),
      );
      await next();
      await next();

      const exchanges = [...Map.groupBy(events(), ({ trace_id }) => trace_id).values()];
      const urls = exchanges.map((exchange) => (exchange[0] as { url: string }).url);
      expect(urls.sort()).toEqual(["/v1/messages?n=1", "/v1/messages?n=2"]);
      for (const exchange of exchanges) {
        const { url } = exchange[0] as { url: string };
        expect(shape(exchange)).toEqual(["request", "request_body", "request_trailers", "response", "response_body", "response_trailers", "end"]);
        expect(bodyOf(exchange, "request_body").toString()).toBe(`asking ${url}`);
        expect(bodyOf(exchange, "response_body").toString()).toBe(`answer to ${url}`);
      }
    });

    it("records a failed connection to the upstream as the exchange's ending", async () => {
      const { port, next, events } = await proxyTo(refusingAddress);

      await buffer(await send(port, { method: "POST", path: "/v1/messages" }));
      await next();

      expect(shape(events())).toEqual(["request", "request_trailers", "end"]);
      expect(events().at(-1)).toMatchObject({ outcome: "error", error: expect.stringContaining("ECONNREFUSED") });
    });

    it("answers 502 to a request node's client refuses to forward, and keeps serving", async () => {
      const upstream = await upstreamServing((_req, res) => res.end("answer"));
      const { port, next, events } = await proxyTo(upstream);

      // Raw, because node's own client refuses to send it: a Trailer header on a body that is not chunked.
      const agent = createConnection(port, LOOPBACK);
      agent.end("POST /v1/messages HTTP/1.1\r\nhost: x\r\ntrailer: x-a\r\ncontent-length: 2\r\n\r\nok");
      const answer = (await buffer(agent)).toString();
      await next();

      expect(answer).toMatch(/^HTTP\/1\.1 502 /);
      expect(answer).toContain("ERR_HTTP_TRAILER_INVALID");
      expect(shape(events())).toEqual(["request", "end"]);
      expect(events().at(-1)).toMatchObject({ outcome: "error", error: expect.stringContaining("ERR_HTTP_TRAILER_INVALID") });
      const after = await send(port, { path: "/v1/models" });
      await buffer(after);
      expect(after.statusCode).toBe(200);
    });

    it("records a stream the upstream cuts, up to the cut", async () => {
      const upstream = await upstreamServing((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n", () => req.socket.destroy());
      });
      const { port, next, events } = await proxyTo(upstream);

      await expect(buffer(await send(port, { method: "POST", path: "/v1/messages" }))).rejects.toThrow(/aborted/);
      await next();

      expect(shape(events())).toEqual(["request", "request_trailers", "response", "response_body", "end"]);
      expect(bodyOf(events(), "response_body").toString()).toBe("event: message_start\n\n");
      expect(events().at(-1)).toMatchObject({ outcome: "error" });
    });

    it("records the agent leaving mid-stream as an aborted ending", async () => {
      const upstream = await upstreamServing((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n");
      });
      const { port, next, events } = await proxyTo(upstream);

      const res = await send(port, { method: "POST", path: "/v1/messages" });
      await once(res, "data");
      res.destroy();
      await next();

      expect(shape(events())).toEqual(["request", "request_trailers", "response", "response_body", "end"]);
      expect(events().at(-1)).toMatchObject({ outcome: "aborted" });
    });

    it("records a response node cannot relay to the agent", async () => {
      const upstream = await upstreamServing((req) => req.socket.end("HTTP/1.1 099 Early\r\ncontent-length: 2\r\n\r\nok"));
      const { port, next, events } = await proxyTo(upstream);

      await expect(send(port, { method: "POST", path: "/v1/messages" })).rejects.toThrow(/socket hang up/);
      await next();

      expect(events().find(({ type }) => type === "response")).toMatchObject({ status: 99, reason: "Early" });
      expect(events().at(-1)).toMatchObject({ type: "end", outcome: "error", error: expect.stringContaining("ERR_HTTP_INVALID_STATUS_CODE") });
    });

    it("ends an exchange with its last event when the upstream answers before the agent finishes sending", async () => {
      const upstream = await upstreamServing((_req, res) => res.end("early"));
      const { port, next, events } = await proxyTo(upstream);

      // Raw, so the agent keeps sending after its answer, as a client that does not watch for one would.
      const agent = createConnection(port, LOOPBACK);
      agent.write("POST /v1/messages HTTP/1.1\r\nhost: x\r\ncontent-length: 10\r\n\r\nfirst");
      await once(agent, "data");
      await next();
      agent.end("later");
      await once(agent, "close");

      expect(shape(events())).toEqual(["request", "request_body", "response", "response_body", "response_trailers", "end"]);
    });

    it("logs a recording that cannot be written once, counted, beside the exchange's own ending", async () => {
      const upstream = await upstreamServing((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n", () => req.socket.destroy());
      });
      const { port, next, path, recordLog } = await proxyTo(upstream);
      rmSync(dirname(path), { recursive: true });

      const res = await send(port, { method: "POST", path: "/v1/messages" });
      const [first] = (await once(res, "data")) as [Buffer];
      await expect(buffer(res)).rejects.toThrow(/aborted/);
      const exchange = await next();

      expect(first.toString()).toBe("event: message_start\n\n");
      expect(exchange).toMatchObject({ event: "request", outcome: "error", status: 200 });
      expect(exchange.error).not.toContain("ENOENT");
      expect(await recordLog.next()).toMatchObject({
        event: "record",
        trace_id: exchange.trace_id,
        outcome: "error",
        error: expect.stringContaining("ENOENT"),
        path,
        counts: { events_written: 0, bytes_written: 0, events_failed: 5 },
      });
    });

    it("continues a recording already at its path after its last whole line, cutting what a crash left", async () => {
      const upstream = await upstreamServing((_req, res) => res.end("answer"));
      const { port, next, path, events, recordLog } = await proxyTo(upstream);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{"an":"earlier event"}\n{"cut');

      expect(await buffer(await send(port, { path: "/v1/models" }))).toEqual(Buffer.from("answer"));
      await next();

      const written = readFileSync(path, "utf8");
      expect(written.startsWith('{"an":"earlier event"}\n{"timestamp"')).toBe(true);
      expect(written).not.toContain('{"cut');
      expect(shape(events().slice(1))).toEqual(["request", "request_trailers", "response", "response_body", "response_trailers", "end"]);
      expect(await recordLog.next()).toMatchObject({ event: "record", outcome: "ok" });
    });

    it("never recreates a recording deleted mid-run, and logs each event it could not write", async () => {
      const upstream = await upstreamServing((_req, res) => res.end("answer"));
      const { port, next, path, recordLog } = await proxyTo(upstream);
      await buffer(await send(port, { path: "/v1/models" }));
      await next();
      await recordLog.next();
      rmSync(path);

      await buffer(await send(port, { path: "/v1/models" }));
      const exchange = await next();

      expect(existsSync(path)).toBe(false);
      expect(await recordLog.next()).toMatchObject({
        event: "record",
        trace_id: exchange.trace_id,
        outcome: "error",
        error: expect.stringContaining("ENOENT"),
        counts: { events_written: 0, bytes_written: 0, events_failed: 6 },
      });
    });

    it("writes no file for a run with no traffic", async () => {
      const { path } = await proxyTo(refusingAddress);

      expect(existsSync(path)).toBe(false);
    });

    it("leaves every event it saw up to the moment the proxy is killed", async () => {
      const upstream = await upstreamServing((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n");
      });
      const { dir, events } = recordingsDir();
      const { child, proxyPort } = await proxyProcess(upstream.href, dir, "unlimited");

      const res = await send(proxyPort, { method: "POST", path: "/v1/messages", headers: { "content-length": String(body.length) }, body });
      await once(res, "data");
      const cut = expect(buffer(res)).rejects.toThrow(/aborted/);
      child.kill("SIGKILL");
      await once(child, "exit");
      await cut;

      expect(shape(events())).toEqual(["request", "request_body", "request_trailers", "response", "response_body"]);
      expect(bodyOf(events(), "request_body").equals(body)).toBe(true);
      expect(bodyOf(events(), "response_body").toString()).toBe("event: message_start\n\n");
    });

    // A proxy process with the work a stop must cut open: an exchange streaming from an upstream that never
    // ends, and a reader following a recording. `untilShutdown` takes every event up to the stop's own.
    async function proxyWithWorkOpen() {
      const upstream = await upstreamServing((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n");
      });
      const { dir, events } = recordingsDir();
      const { child, proxyPort, readerPort, next } = await proxyProcess(upstream.href, dir, "unlimited");
      const exchange = await send(proxyPort, { method: "POST", path: "/v1/messages", headers: { "content-length": String(body.length) }, body });
      await once(exchange, "data");
      const reader = await send(readerPort, { path: `/recordings/${runName}` });
      const cut = Promise.all([exchange, reader].map((res) => expect(buffer(res)).rejects.toThrow(/aborted/)));
      const untilShutdown = async () => {
        const logged = [];
        do logged.push(await next());
        while (logged.at(-1)!.event !== "shutdown");
        return logged;
      };
      return { child, events, cut, untilShutdown };
    }

    it.each(["SIGINT", "SIGTERM"] as const)("on %s, ends every exchange and reader still open as stopped, then exits", async (signal) => {
      const { child, events, cut, untilShutdown } = await proxyWithWorkOpen();

      const exited = once(child, "exit");
      child.kill(signal);
      const logged = await untilShutdown();
      await cut;

      expect(await exited).toEqual([0, null]);
      const requests = logged.filter(({ event }) => event === "request");
      expect(requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: "POST", url: "/v1/messages", outcome: "stopped", status: 200 }),
          expect.objectContaining({ method: "GET", url: `/recordings/${runName}`, outcome: "stopped", status: 200 }),
        ]),
      );
      expect(requests).toHaveLength(2);
      expect(logged.filter(({ event }) => event === "close")).toMatchObject([{ requests_open: 1 }, { requests_open: 1 }]);
      expect(logged.at(-1)).toMatchObject({ event: "shutdown", outcome: "ok", signal });
      const exchangeTrace = requests.find(({ method }) => method === "POST")!.trace_id;
      expect(events().at(-1)).toMatchObject({ type: "end", trace_id: exchangeTrace, outcome: "stopped" });
    });

    it("finishes a stop whose signal arrives again and again, as one Ctrl-C under `pnpm dev` does", async () => {
      const { child, cut, untilShutdown } = await proxyWithWorkOpen();

      // Once from the terminal, then again from each supervisor that forwards it. One that lands as node
      // exits kills it there, after every event, so the exit status is not this test's to check.
      const closed = once(child, "close");
      const repeating = setInterval(() => child.kill("SIGINT"), 1);
      void closed.then(() => clearInterval(repeating));
      child.kill("SIGINT");
      await closed;
      await cut;

      const logged = await untilShutdown();
      expect(logged.filter(({ event }) => event === "request")).toMatchObject([{ outcome: "stopped" }, { outcome: "stopped" }]);
      expect(logged.at(-1)).toMatchObject({ event: "shutdown", outcome: "ok", signal: "SIGINT" });
    });
  });
});

