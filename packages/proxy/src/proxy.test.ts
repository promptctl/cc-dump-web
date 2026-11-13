import { once } from "node:events";
import { createServer, request, type IncomingMessage, type RequestListener } from "node:http";
import { createConnection } from "node:net";
import { buffer } from "node:stream/consumers";
import { gzipSync } from "node:zlib";
import { listen } from "@cc-dump/log";
import { closedAfterTest, eventLog, sendRaw } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { createProxy } from "./proxy.ts";

async function upstreamServing(handler: RequestListener): Promise<URL> {
  const port = await listen(() => {}, closedAfterTest(createServer(handler)), 0);
  return new URL(`http://127.0.0.1:${port}`);
}

// Nothing listens on port 1. localhost, because it resolves to more than one address on most
// hosts, and refusal by all of them is an AggregateError.
const refusingAddress = new URL("http://localhost:1");

async function proxyTo(upstream: URL) {
  const { log, next } = eventLog();
  const port = await listen(() => {}, closedAfterTest(createProxy(log, upstream)), 0);
  return { port, next };
}

// Raw node:http on the agent's side, so bytes are compared as sent (fetch would decompress gzip).
type Sent = { method?: string; path: string; headers?: Record<string, string>; body?: Buffer };

// The caller frames the body: node's default framing for a GET is none at all.
async function send(port: number, { method = "GET", path, headers = {}, body }: Sent): Promise<IncomingMessage> {
  const req = request({ port, method, path, headers });
  req.end(body);
  const [res] = (await once(req, "response")) as [IncomingMessage];
  return res;
}

function pairs(rawHeaders: string[]): [string, string][] {
  return rawHeaders.flatMap((name, i): [string, string][] => (i % 2 ? [] : [[name, rawHeaders[i + 1]!]]));
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

    const agent = createConnection(port, "127.0.0.1");
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
    const { port, next } = await proxyTo(upstream);

    const res = await send(port, { method: "POST", path: "/v1/messages" });
    await once(res, "data");
    res.destroy();

    await closedUpstream;
    expect(await next()).toMatchObject({ outcome: "aborted" });
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
    const { port, next } = await proxyTo(upstream);

    const req = request({ port, method: "POST", path: "/v1/messages" });
    const hungUp = once(req, "error");
    req.end();
    await arrived;
    req.destroy();

    await expect(hungUp).resolves.toEqual([expect.objectContaining({ code: "ECONNRESET" })]);
    await closedUpstream;
    expect(await next()).toMatchObject({ outcome: "aborted" });
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

  it.each(["ftp://example.com", "https://gw.example/anthropic?key=1", "https://user:pw@gw.example", "https://gw.example/#a"])(
    "refuses the upstream %s, which it could not forward to as given",
    (href) => {
      expect(() => createProxy(() => {}, new URL(href))).toThrow(/http or https origin/);
    },
  );
});
