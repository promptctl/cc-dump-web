import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { RequestListener, Server } from "node:http";
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

// [LAW:single-enforcer] Every HTTP request of every part is logged here and nowhere else.
// It observes the response; what a handler failure should do is decided with the first handler
// that can fail.
export function withRequestEvent(log: Log, handler: RequestListener): RequestListener {
  return (req, res) => {
    const span = startSpan();
    res.on("close", () =>
      log({
        event: "request",
        ...span.end(),
        outcome: res.writableFinished ? "ok" : "aborted",
        method: req.method,
        url: req.url,
        // The status the handler set; on an aborted request the client may not have received it.
        status: res.headersSent ? res.statusCode : null,
      }),
    );
    handler(req, res);
  };
}

// Startup is a unit of work too: a port that cannot be bound writes its event, then rethrows,
// so the process exits non-zero.
export async function listen(log: Log, server: Server, port: number): Promise<void> {
  const span = startSpan();
  try {
    server.listen(port);
    await once(server, "listening");
    log({ event: "listen", ...span.end(), outcome: "ok", port: (server.address() as AddressInfo).port });
  } catch (error) {
    log({ event: "listen", ...span.end(), outcome: "error", error: inspect(error), port });
    throw error;
  }
}

function startSpan() {
  // W3C Trace Context trace-id: 16 random bytes as lowercase hex.
  const trace_id = randomBytes(16).toString("hex");
  const started_at = new Date().toISOString();
  const started = performance.now();
  return { end: () => ({ trace_id, started_at, duration_ms: Math.round(performance.now() - started) }) };
}
