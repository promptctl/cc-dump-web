import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { buffer } from "node:stream/consumers";
import { expect, onTestFinished } from "vitest";
import { LOOPBACK } from "./address.ts";
import { parseTraceId } from "./trace.ts";
import { serve, type Event, type Handler, type Upgrade } from "./index.ts";

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

// Serves `handler`, and `upgrade` if given, on a free port until the test finishes. Binding the port is the log's first event,
// taken here, so `next` yields the events of the handler's work.
export async function serving(handler: Handler, upgrade?: Upgrade) {
  const { log, next } = eventLog();
  const { port, close } = await serve(log, handler, 0, upgrade);
  onTestFinished(close);
  expect(await next()).toMatchObject({ event: "listen", outcome: "ok", address: LOOPBACK, port });
  return { port, url: `http://${LOOPBACK}:${port}`, next };
}

// The event of a unit of work `name` as a test logs it: started at a fixed time, ended as it should.
export const workEvent = (name: string) => ({ event: name, trace_id: parseTraceId("t"), started_at: "2026-11-16T09:00:00.000Z", duration_ms: 1.5, outcome: "ok" as const });

export type ServerSentEvent = { id?: string; event?: string; data: string };

// A Server-Sent Events client of a server on `port`: `next()` resolves with each event as it arrives.
export async function subscribe(port: number, path: string, headers: Record<string, string> = {}) {
  const res = await send(port, { path, headers });
  const { arrive, next } = arrivals<ServerSentEvent>();
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    text += chunk;
    for (let at = text.indexOf("\n\n"); at !== -1; at = text.indexOf("\n\n")) {
      const fields = text
        .slice(0, at)
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]);
      text = text.slice(at + 2);
      arrive({ data: "", ...Object.fromEntries(fields) } as ServerSentEvent);
    }
  });
  const take = async (n: number) => {
    const events: ServerSentEvent[] = [];
    while (events.length < n) events.push(await next());
    return events;
  };
  return { res, next, take };
}
