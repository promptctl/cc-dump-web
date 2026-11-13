import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { inspect } from "node:util";

// [LAW:nothing-unseen] One wide event per unit of work, carrying the observability floor's default
// fields. Parts add facts beside them and never rename them; `service` is added by the sink.
// [LAW:types-are-the-program] An error is carried exactly when the outcome is "error".
export type Ending = { outcome: "ok" | "aborted"; error?: never } | { outcome: "error"; error: string };
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

// A handler answers through `res` and reports a failure of its work through `fail`; what the
// client is sent when that happens is the handler's decision, made before or after `fail`.
export type Handler = (req: IncomingMessage, res: ServerResponse, fail: (error: unknown) => void) => void;

export type Serving = { port: number; close: () => Promise<void> };

// [LAW:single-enforcer] The one way a part serves HTTP: it hands over its handler, never a server, so
// every unit of work it does with a client is logged here and nowhere else: each request its handler
// receives, each connection error, and binding the port. A port that cannot be bound writes its event,
// then rethrows, so the process exits non-zero. Port 0 binds a free one; `port` is the one bound.
export async function serve(log: Log, handler: Handler, port: number): Promise<Serving> {
  const server = loggedServer(log, handler);
  const span = startSpan();
  try {
    server.listen(port);
    await once(server, "listening");
  } catch (error) {
    log({ event: "listen", ...span.end(), outcome: "error", error: describe(error), port });
    throw error;
  }
  const bound = (server.address() as AddressInfo).port;
  log({ event: "listen", ...span.end(), outcome: "ok", port: bound });
  return {
    port: bound,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function loggedServer(log: Log, handler: Handler): Server {
  const server = createHttpServer(withRequestEvent(log, handler));
  server.on("connection", (socket: Socket) => {
    const span = startSpan();
    const client = clientOf(socket);
    // Every request node:http refuses (a malformed request line, headers over its limit, a bad chunk, a
    // request timeout) and every connection the client resets ends in node destroying the socket with
    // the error, after node has answered if it could, so this observes them and the answer stays node's.
    // A connection's lifecycle is not a request's, so the event is its own, spanning the connection up to
    // its error; `client` joins it to the request events of the same connection.
    socket.on("error", (error) => log({ event: "client_error", ...span.end(), outcome: "error", error: describe(error), ...client }));
  });
  return server;
}

// OpenTelemetry's client.address and client.port: the peer of the TCP connection. Read while the socket
// is live, when a unit of work begins: a destroyed socket reports them only if something read them earlier.
function clientOf(socket: Socket) {
  return { client_address: socket.remoteAddress, client_port: socket.remotePort };
}

// The event is written once, when the response closes: an error reported before then is its
// outcome, the first one if there were several.
function withRequestEvent(log: Log, handler: Handler): RequestListener {
  return (req, res) => {
    const span = startSpan();
    const client = clientOf(req.socket);
    let failure: string | undefined;
    res.on("close", () => {
      const ending: Ending =
        failure === undefined ? { outcome: res.writableFinished ? "ok" : "aborted" } : { outcome: "error", error: failure };
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
    handler(req, res, (error) => (failure ??= describe(error)));
  };
}

// [LAW:single-enforcer] Every error an event carries is rendered here. An llhttp parse error carries
// the raw bytes of the message it was parsing as `rawPacket`: a request's (x-api-key included) on a
// server's socket, an upstream response's (set-cookie included) on a client's. The event records what
// node said about the bytes, never the bytes.
function describe(error: unknown): string {
  if (!(error instanceof Error && "rawPacket" in error)) return inspect(error);
  const said = Object.assign(new Error(error.message), error, { stack: error.stack });
  delete said.rawPacket;
  return inspect(said);
}

function startSpan() {
  // W3C Trace Context trace-id: 16 random bytes as lowercase hex.
  const trace_id = randomBytes(16).toString("hex");
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { end: () => ({ trace_id, started_at, duration_ms: performance.now() - started }) };
}
