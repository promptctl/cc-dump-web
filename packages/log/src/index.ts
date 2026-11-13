import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { inspect } from "node:util";
import { LOOPBACK } from "./address.ts";
import type { Ending } from "./ending.ts";

export type { Ending };

// [LAW:nothing-unseen] One wide event per unit of work, carrying the observability floor's default
// fields. Parts add facts beside them and never rename them; `service` is added by the sink.
export type Event = {
  event: string;
  trace_id: string;
  started_at: string;
  duration_ms: number;
  service?: never;
  [fact: string]: unknown;
} & Ending;
export type Log = (event: Event) => void;

// The export edge: one JSON line per event, written wherever the entry point's `write` sends it.
export function createLog(service: string, write: (line: string) => void): Log {
  return (event) => write(`${JSON.stringify({ service, ...event })}\n`);
}

// A part's facts about a unit of work: any name but the floor's, read off `Event`.
type FloorField = keyof { [K in keyof Event as string extends K ? never : K]: unknown };
export type Facts = { [fact: string]: unknown } & { [K in FloorField]?: never };

// A synchronous unit of work done outside any request, such as a part's setup: its event is written when
// `work` returns, or when it throws, and then the error is rethrown. A promise is refused: its event
// would be written before the work had happened.
export function logged<T>(log: Log, event: string, facts: Facts, work: () => T extends PromiseLike<unknown> ? never : T): T {
  const span = startSpan();
  try {
    const result = work();
    log({ event, ...facts, ...span.end(), outcome: "ok" });
    return result;
  } catch (error) {
    log({ event, ...facts, ...span.end(), outcome: "error", error: describeError(error) });
    throw error;
  }
}

// The request's unit of work as its event records it. A handler reports a failure through `fail`;
// what the client is sent when that happens is the handler's decision, made before or after `fail`.
// `ended` resolves when the response closes, with the ending the event records.
// [LAW:no-ambient-temporal-coupling] A promise's callbacks are queued together when it resolves, so what
// a handler subscribes to `ended` before the request ends runs before its server's `close` resolves.
export type Work = { trace_id: string; fail: (error: unknown) => void; ended: Promise<Ending> };

export type Handler = (req: IncomingMessage, res: ServerResponse, work: Work) => void;

// `close` stops accepting connections, cuts every one still open, and resolves once the event of every
// request it cut is written.
export type Serving = { port: number; close: () => Promise<void> };

// [LAW:single-enforcer] The one way a part serves HTTP: it hands over its handler, never a server, so
// every unit of work it does with a client is logged here and nowhere else: each request its handler
// receives, each connection error, binding the port, and closing it. A port that cannot be bound or closed
// writes its event, then rethrows, so the process exits non-zero. Port 0 binds a free one; `port` is the one bound.
// The port is bound on LOOPBACK, so one another process holds there is refused, not shared.
export async function serve(log: Log, handler: Handler, port: number): Promise<Serving> {
  const inFlight = new Set<Promise<Ending>>();
  const server = loggedServer(log, handler, inFlight);
  const span = startSpan();
  try {
    server.listen(port, LOOPBACK);
    await once(server, "listening");
  } catch (error) {
    log({ event: "listen", ...span.end(), outcome: "error", error: describeError(error), address: LOOPBACK, port });
    throw error;
  }
  const { address, port: bound } = server.address() as AddressInfo;
  log({ event: "listen", ...span.end(), outcome: "ok", address, port: bound });
  return {
    port: bound,
    close: () => {
      // [LAW:no-ambient-temporal-coupling] The server's close can come before the close of a response it
      // cut, which is when that request's event is written, so each cut request's `ended` is awaited too.
      const cut = [...inFlight];
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      return loggedAll(log, "close", { port: bound, requests_open: cut.length }, [closed, ...cut]);
    },
  };
}

// [LAW:single-enforcer] The one way a part's process stops: graceful shutdown on SIGINT or SIGTERM closes
// every server, so each request still open is cut and its event written, then writes its own event, naming
// the first signal. Nothing is left holding the event loop, so the process exits by itself, once stdout has
// drained, with code 1 and the error on stderr if the stop failed, as node reports an error nothing handled.
// One Ctrl-C reaches the process more than once: the terminal signals its whole process group, and each
// supervisor in it (concurrently, pnpm, node --watch) forwards the signal again. So the first signal
// resolves the stop and every later one finds it resolved. The listeners stay after the stop: a forwarded
// signal that got node's default kill would end the process before stdout drained the stop's events. A
// shutdown that hangs is killed with SIGKILL.
export function shutdownOnSignal(log: Log, servers: Serving[]) {
  const signalled = new Promise<NodeJS.Signals>((resolve) => process.on("SIGINT", resolve).on("SIGTERM", resolve));
  void signalled
    .then((signal) => loggedAll(log, "shutdown", { signal }, servers.map(({ close }) => close())))
    .catch((error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`${describeError(error)}\n`);
    });
}

// A unit of work that is several at once: its event is written once every one has settled, so one that
// fails cuts none of the others short, and then the first failure is rethrown.
async function loggedAll(log: Log, event: string, facts: Facts, work: Promise<unknown>[]) {
  const span = startSpan();
  const failure = (await Promise.allSettled(work)).find((result) => result.status === "rejected");
  if (failure) {
    log({ event, ...facts, ...span.end(), outcome: "error", error: describeError(failure.reason) });
    throw failure.reason;
  }
  log({ event, ...facts, ...span.end(), outcome: "ok" });
}

function loggedServer(log: Log, handler: Handler, inFlight: Set<Promise<Ending>>): Server {
  const server = createHttpServer();
  server.on("request", withRequestEvent(log, handler, server, inFlight));
  server.on("connection", (socket: Socket) => {
    const span = startSpan();
    const client = clientOf(socket);
    // Every request node:http refuses (a malformed request line, headers over its limit, a bad chunk, a
    // request timeout) and every connection the client resets ends in node destroying the socket with
    // the error, after node has answered if it could, so this observes them and the answer stays node's.
    // A connection's lifecycle is not a request's, so the event is its own, spanning the connection up to
    // its error; `client` joins it to the request events of the same connection.
    socket.on("error", (error) => log({ event: "client_error", ...span.end(), outcome: "error", error: describeError(error), ...client }));
  });
  return server;
}

// OpenTelemetry's client.address and client.port: the peer of the TCP connection. Read while the socket
// is live, when a unit of work begins: a destroyed socket reports them only if something read them earlier.
function clientOf(socket: Socket) {
  return { client_address: socket.remoteAddress, client_port: socket.remotePort };
}

// The event is written once, when the response closes: an error reported before then is its
// outcome, the first one if there were several. A response cut short was stopped if its server had stopped
// listening by then, which only `close` does, and was left by its client otherwise.
// [LAW:one-source-of-truth] This is the one place that decides why a request ended; the handler reads it
// from `ended`. The request is in flight, for `close` to wait on, until it is decided.
function withRequestEvent(log: Log, handler: Handler, server: Server, inFlight: Set<Promise<Ending>>): RequestListener {
  return (req, res) => {
    const span = startSpan();
    const client = clientOf(req.socket);
    let failure: string | undefined;
    const { promise: ended, resolve: end } = Promise.withResolvers<Ending>();
    inFlight.add(ended);
    res.on("close", () => {
      const cut = server.listening ? "aborted" : "stopped";
      const ending: Ending =
        failure === undefined ? { outcome: res.writableFinished ? "ok" : cut } : { outcome: "error", error: failure };
      inFlight.delete(ended);
      end(ending);
      log({
        event: "request",
        ...span.end(),
        ...ending,
        method: req.method,
        url: req.url,
        // The status the handler set; on a cut response the client may not have received it.
        status: res.headersSent ? res.statusCode : null,
        ...client,
      });
    });
    const fail = (error: unknown) => (failure ??= describeError(error));
    // A handler that throws fails its own request, which is cut, and not the process with every other request in it.
    try {
      handler(req, res, { trace_id: span.trace_id, fail, ended });
    } catch (error) {
      fail(error);
      res.destroy();
    }
  };
}

// [LAW:single-enforcer] Every error an event carries is rendered here. An llhttp parse error carries
// the raw bytes of the message it was parsing as `rawPacket`: a request's (x-api-key included) on a
// server's socket, an upstream response's (set-cookie included) on a client's. The event records what
// node said about the bytes, never the bytes.
export function describeError(error: unknown): string {
  if (!(error instanceof Error && "rawPacket" in error)) return inspect(error);
  const said = Object.assign(new Error(error.message), error, { stack: error.stack });
  delete said.rawPacket;
  return inspect(said);
}

// The floor's span fields, for any unit of work a part times itself. A unit of work inside another's
// trace (a request's recording) takes that trace_id; a new one is W3C Trace Context's: 16 random bytes
// as lowercase hex.
export function startSpan(trace_id = randomBytes(16).toString("hex")) {
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { trace_id, end: () => ({ trace_id, started_at, duration_ms: performance.now() - started }) };
}
