import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

// [LAW:single-enforcer] Every request a part's handler receives is logged here and nowhere else.
// Requests node:http rejects before any handler (a clientError: bad headers, 431) never get here.
// The event is written once, when the response closes: an error reported before then is its
// outcome, the first one if there were several.
export function withRequestEvent(log: Log, handler: Handler): RequestListener {
  return (req, res) => {
    const span = startSpan();
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
      });
    });
    handler(req, res, (error) => (failure ??= inspect(error)));
  };
}

// Startup is a unit of work too: a port that cannot be bound writes its event, then rethrows,
// so the process exits non-zero. Resolves with the bound port (port 0 binds a free one).
export async function listen(log: Log, server: Server, port: number): Promise<number> {
  const span = startSpan();
  try {
    server.listen(port);
    await once(server, "listening");
  } catch (error) {
    log({ event: "listen", ...span.end(), outcome: "error", error: inspect(error), port });
    throw error;
  }
  const bound = (server.address() as AddressInfo).port;
  log({ event: "listen", ...span.end(), outcome: "ok", port: bound });
  return bound;
}

function startSpan() {
  // W3C Trace Context trace-id: 16 random bytes as lowercase hex.
  const trace_id = randomBytes(16).toString("hex");
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { end: () => ({ trace_id, started_at, duration_ms: performance.now() - started }) };
}
