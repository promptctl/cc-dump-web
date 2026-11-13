import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { buffer } from "node:stream/consumers";
import { expect, onTestFinished } from "vitest";
import { LOOPBACK } from "./address.ts";
import { serve, type Event, type Handler } from "./index.ts";

// What arrives while a test runs, in order: `next()` resolves with each in turn, waiting for one not yet arrived;
// `queued()` counts those arrived and not yet taken.
export function arrivals<T>() {
  const arrived: T[] = [];
  const waiting: ((arrival: T) => void)[] = [];
  return {
    arrive: (arrival: T) => void (waiting.length ? waiting.shift()!(arrival) : arrived.push(arrival)),
    next: () => new Promise<T>((resolve) => (arrived.length ? resolve(arrived.shift()!) : waiting.push(resolve))),
    queued: () => arrived.length,
  };
}

// A log the test can wait on: `next()` resolves with the next event written.
export function eventLog() {
  const { arrive, next } = arrivals<Event>();
  return { log: arrive, next };
}

// The client's side of one connection, raw, so node's own answer is read as it was sent.
export async function sendRaw(port: number, bytes: string) {
  const socket = createConnection(port, LOOPBACK);
  await once(socket, "connect");
  // Read while connected: a closed socket no longer reports its port.
  const clientPort = socket.localPort;
  socket.end(bytes);
  return { reply: (await buffer(socket)).toString(), clientPort };
}

// Raw node:http on the client's side, so bytes are compared as sent (fetch would decompress gzip).
type Sent = { method?: string; path: string; headers?: Record<string, string>; body?: Buffer };

// The caller frames the body: node's default framing for a GET is none at all.
export async function send(port: number, { method = "GET", path, headers = {}, body }: Sent): Promise<IncomingMessage> {
  const req = request({ host: LOOPBACK, port, method, path, headers });
  req.end(body);
  const [res] = (await once(req, "response")) as [IncomingMessage];
  return res;
}

// Serves `handler` on a free port until the test finishes. Binding the port is the log's first event,
// taken here, so `next` yields the events of the handler's work.
export async function serving(handler: Handler) {
  const { log, next } = eventLog();
  const { port, close } = await serve(log, handler, 0);
  onTestFinished(close);
  expect(await next()).toMatchObject({ event: "listen", outcome: "ok", address: LOOPBACK, port });
  return { port, url: `http://${LOOPBACK}:${port}`, next };
}
