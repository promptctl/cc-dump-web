import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { inspect } from "node:util";
import { LOOPBACK } from "./address.ts";
import { requestEnding, type Ending } from "./ending.ts";
import { mintTraceId, type TraceId } from "./trace.ts";

export type { Ending, TraceId };

// [LAW:nothing-unseen] One wide event per unit of work, carrying the observability floor's default
// fields. Parts add facts beside them and never rename them; `service` is added by the sink.
export type Event = {
  event: string;
  trace_id: TraceId;
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
// `work` returns, with the facts `found` reads off its result, or when either throws, and then the error is rethrown.
// A promise is refused: its event would be written before the work had happened.
export function logged<T>(
  log: Log,
  event: string,
  facts: Facts,
  work: () => T extends PromiseLike<unknown> ? never : T,
  found: (result: T) => Facts = () => ({}),
): T {
  const unit = unitOfWork(log, event, facts, startTrace());
  try {
    const result = work();
    unit.end({ outcome: "ok" }, () => found(result));
    return result;
  } catch (error) {
    unit.end(failed(error));
    throw error;
  }
}

// An asynchronous unit of work in the trace `trace_id` names: its event is written once `work` settles, with the facts
// `found` reads off its result, or when it rejects, and then the error is rethrown.
export async function loggedIn<T>(log: Log, trace_id: TraceId, event: string, facts: Facts, work: () => Promise<T>, found: (result: T) => Facts = () => ({})): Promise<T> {
  const unit = unitOfWork(log, event, facts, startSpan(trace_id));
  try {
    const result = await work();
    unit.end({ outcome: "ok" }, () => found(result));
    return result;
  } catch (error) {
    unit.end(failed(error));
    throw error;
  }
}

// A unit of work, inside another's trace, that something else did and timed, reported once it has ended: it took
// `duration_ms`, up to now, and ended as `ending` says.
export function loggedAfter(log: Log, trace_id: TraceId, event: string, facts: Facts, duration_ms: number, ending: Ending) {
  const span: Span = { trace_id, end: () => ({ trace_id, started_at: new Date(Date.now() - duration_ms).toISOString(), duration_ms }) };
  unitOfWork(log, event, facts, span).end(ending);
}

// The ending of work that failed with `error`.
export function failed(error: unknown): Ending {
  return { outcome: "error", error: describeError(error) };
}

// [LAW:single-enforcer] A unit of work's one owner of how it ended, and so the one writer of its event. It keeps the
// first failure reported while the work runs (a request's, an upgrade's, a recording's); `end` says how the work itself
// reached its end, and a failure kept stands over that. A unit ends once: where several paths race to end one (a read
// caught up, failed, or cut by its request), the first is its ending and a later one changes nothing.
// [LAW:no-ambient-temporal-coupling] `end` measures all the event carries (the span, the facts `found` reads off the
// work's end) while the unit is still open, so a measure that throws leaves it open for the failure its caller then
// gives. Only then is it ended, `ended` resolved, and the event written: a write that throws surfaces as itself, is never
// followed by a second write, and leaves nothing waiting on `ended`.
// `judged` is how the event reads the unit's ending, where it judges more than `ended` says: a request's, by its status.
export function unitOfWork(log: Log, event: string, facts: Facts, span: Span, judged: (ending: Ending) => Ending = (ending) => ending) {
  let failure: Ending | undefined;
  let open = true;
  const { promise: ended, resolve } = Promise.withResolvers<Ending>();
  return {
    ended,
    fail: (error: unknown) => void (failure ??= failed(error)),
    end: (reached: Ending, found: () => Facts = () => ({})) => {
      if (!open) return;
      const ending = failure ?? reached;
      const written: Event = { event, ...facts, ...span.end(), ...found(), ...judged(ending) };
      open = false;
      resolve(ending);
      log(written);
    },
  };
}

// The request's unit of work as its event records it. A handler reports a failure through `fail`;
// what the client is sent when that happens is the handler's decision, made before or after `fail`.
// `ended` resolves when the response closes, with how its response ended: sent in full, cut, or failed as the handler
// reported. How the request ended, which its event records, is judged from that and its status (`requestEnding`).
// [LAW:no-ambient-temporal-coupling] A promise's callbacks are queued together when it resolves, so what
// a handler subscribes to `ended` before the request ends runs before its server's `close` resolves.
export type Work = { trace_id: TraceId } & Pick<ReturnType<typeof unitOfWork>, "fail" | "ended">;

export type Handler = (req: IncomingMessage, res: ServerResponse, work: Work) => void;

// A request to switch protocols (a WebSocket's) that the part takes over: from here the connection's socket is the
// part's, and the unit of work is the connection's whole life. The part's promise settles once it is done with the
// connection, and the event is written, and `work.ended` resolves, once that and the socket's close have both happened,
// so a failure the part learns of as the connection ends is the upgrade's outcome.
export type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, work: Work) => Promise<void>;

// `close` stops accepting connections, cuts every one still open, upgraded ones too, and resolves once the event of
// every request and upgrade it cut is written.
export type Serving = { port: number; close: () => Promise<void> };

// [LAW:single-enforcer] The one way a part serves HTTP: it hands over its handler, never a server, so
// every unit of work it does with a client is logged here and nowhere else: each request its handler
// receives, each connection error, binding the port, and closing it. A port that cannot be bound or closed
// writes its event, then rethrows, so the process exits non-zero. Port 0 binds a free one; `port` is the one bound.
// The port is bound on LOOPBACK, so a connection dialed there reaches this server or the bind fails: a port another
// process holds on LOOPBACK is refused, and one held on the wildcard, where the kernel shares it (macOS), is shared
// with this server, the more specific bind, which takes the connections dialed to LOOPBACK.
// A part that takes no upgrades gives no `upgrade`, and node hands an upgrade request to `handler` as any other request.
export async function serve(log: Log, handler: Handler, port: number, upgrade?: Upgrade): Promise<Serving> {
  const inFlight = new Set<Promise<Ending>>();
  const upgraded = new Map<Duplex, Promise<Ending>>();
  // [LAW:single-enforcer] Only a WebSocket's upgrade is the part's: node hands every request that offers any Upgrade
  // (an h2c POST included) to the upgrade listener once there is one, so every other reaches `handler` as before.
  const server = loggedServer(log, handler, inFlight, (req) => upgrade !== undefined && req.headers.upgrade?.toLowerCase() === "websocket");
  if (upgrade) server.on("upgrade", withUpgradeEvent(log, upgrade, server, upgraded));
  const bound = await loggedIn(
    log,
    mintTraceId(),
    "listen",
    // `port` is the port bound, as on every event of this server; the port asked for is its own fact.
    { address: LOOPBACK, requested_port: port },
    async () => {
      server.listen(port, LOOPBACK);
      await once(server, "listening");
      return (server.address() as AddressInfo).port;
    },
    (bound) => ({ port: bound }),
  );
  return {
    port: bound,
    close: () => {
      // [LAW:no-ambient-temporal-coupling] The server's close can come before the close of a response it
      // cut, which is when that request's event is written, so each cut request's `ended` is awaited too.
      const cut = [...inFlight];
      const cutUpgrades = [...upgraded];
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      server.closeAllConnections();
      // An upgraded socket is no longer the server's connection, so closeAllConnections does not reach it.
      for (const [socket] of cutUpgrades) socket.destroy();
      return loggedAll(log, "close", { port: bound, requests_open: cut.length, upgrades_open: cutUpgrades.length }, [
        closed,
        ...cut,
        ...cutUpgrades.map(([, ended]) => ended),
      ]);
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
// signal that got node's default kill would end the process before stdout drained the stop's events.
export function shutdownOnSignal(log: Log, servers: Serving[]) {
  const signalled = new Promise<NodeJS.Signals>((resolve) => process.on("SIGINT", resolve).on("SIGTERM", resolve));
  void signalled
    .then((signal) => loggedAll(log, "shutdown", { signal }, servers.map(({ close }) => close())))
    .catch((error: unknown) => {
      process.exitCode = 1;
      process.stderr.write(`${describeError(error)}\n`);
    });
}

// A unit of work that is several at once: its event is written once every one has settled, so one that fails cuts none
// of the others short, and then the first to fail, in time, is rethrown.
function loggedAll(log: Log, event: string, facts: Facts, work: Promise<unknown>[]) {
  const failures: unknown[] = []; // in the order they failed
  const settled = work.map((one) => one.catch((error: unknown) => void failures.push(error)));
  return loggedIn(log, mintTraceId(), event, facts, async () => {
    await Promise.all(settled);
    if (failures.length > 0) throw failures[0];
  });
}

function loggedServer(log: Log, handler: Handler, inFlight: Set<Promise<Ending>>, shouldUpgradeCallback: (req: IncomingMessage) => boolean): Server {
  const server = createHttpServer({ shouldUpgradeCallback });
  server.on("request", withRequestEvent(log, handler, server, inFlight));
  server.on("connection", (socket: Socket) => {
    // Every request node:http refuses (a malformed request line, headers over its limit, a bad chunk, a
    // request timeout) and every connection the client resets ends in node destroying the socket with
    // the error, after node has answered if it could, so this observes them and the answer stays node's.
    // A connection's lifecycle is not a request's, so the event is its own, spanning the connection up to
    // its error; `client` joins it to the request events of the same connection.
    const connection = unitOfWork(log, "client_error", clientOf(socket), startTrace());
    socket.on("error", (error) => connection.end(failed(error)));
  });
  return server;
}

// OpenTelemetry's client.address and client.port: the peer of the TCP connection. Read while the socket
// is live, when a unit of work begins: a destroyed socket reports them only if something read them earlier.
function clientOf(socket: Socket) {
  return { client_address: socket.remoteAddress, client_port: socket.remotePort };
}

// The event is written once, when the response closes. The response's ending is an error reported before then, the
// first one if there were several; or, for a response cut short, stopped if its server had stopped listening by then,
// which only `close` does, and left by its client otherwise; or ok. The request's ending, which its event records, is
// judged from that and the status the handler set, which on a cut response the client may not have received.
// [LAW:one-source-of-truth] This is the one place that decides how a request's response ended, which the handler reads
// from `ended`. The request is in flight, for `close` to wait on, until it is.
function withRequestEvent(log: Log, handler: Handler, server: Server, inFlight: Set<Promise<Ending>>): RequestListener {
  return (req, res) => {
    const span = startTrace();
    const work = unitOfWork(log, "request", { method: req.method, url: req.url, ...clientOf(req.socket) }, span, (response) =>
      requestEnding(response, { status: res.statusCode, reason: res.statusMessage }),
    );
    inFlight.add(work.ended);
    res.on("close", () => {
      inFlight.delete(work.ended);
      work.end({ outcome: res.writableFinished ? "ok" : server.listening ? "aborted" : "stopped" }, () => ({ status: res.headersSent ? res.statusCode : null }));
    });
    // A handler that throws fails its own request, which is cut, and not the process with every other request in it.
    try {
      handler(req, res, { trace_id: span.trace_id, fail: work.fail, ended: work.ended });
    } catch (error) {
      work.fail(error);
      res.destroy();
    }
  };
}

// The upgrade's event is written once, when its socket closes: an error the part reported is its outcome; otherwise a
// socket closed by an error was aborted, one cut by `close` was stopped, and any other ended as it should.
// The upgrade is open, for `close` to cut and wait on, until its socket closes.
function withUpgradeEvent(log: Log, upgrade: Upgrade, server: Server, upgraded: Map<Duplex, Promise<Ending>>) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const span = startTrace();
    const work = unitOfWork(log, "upgrade", { url: req.url, protocol: req.headers.upgrade, ...clientOf(req.socket) }, span);
    upgraded.set(socket, work.ended);
    const closed = new Promise<Exclude<Ending["outcome"], "error">>((resolve) =>
      socket.once("close", (hadError: boolean) => resolve(!server.listening ? "stopped" : hadError ? "aborted" : "ok")),
    );
    const done = Promise.try(upgrade, req, socket, head, { trace_id: span.trace_id, fail: work.fail, ended: work.ended }).catch((error: unknown) => {
      work.fail(error);
      socket.destroy();
    });
    void Promise.all([closed, done]).then(([outcome]) => {
      upgraded.delete(socket);
      work.end({ outcome });
    });
  };
}

// [LAW:single-enforcer] Every error an event carries is rendered here. An llhttp parse error carries
// the raw bytes of the message it was parsing as `rawPacket`: a request's (x-api-key included) on a
// server's socket, an upstream response's (set-cookie included) on a client's. The event records what
// node said about the bytes, never the bytes.
function describeError(error: unknown): string {
  if (!(error instanceof Error && "rawPacket" in error)) return inspect(error);
  const said = Object.assign(new Error(error.message), error, { stack: error.stack });
  delete said.rawPacket;
  return inspect(said);
}

// The floor's span fields, for any unit of work a part times itself: one that begins a trace of its own, or one inside
// another's trace (a request's recording), joining it. Two entries, so a span that joins a trace names the trace it
// joins, and no call mints one for want of an argument.
export function startTrace() {
  return startSpan(mintTraceId());
}

// The floor's span fields, which `end` gives as its unit of work ends.
export type Span = { trace_id: TraceId; end: () => { trace_id: TraceId; started_at: string; duration_ms: number } };

export function startSpan(trace_id: TraceId): Span {
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { trace_id, end: () => ({ trace_id, started_at, duration_ms: performance.now() - started }) };
}
