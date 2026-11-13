import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Handler } from "@cc-dump/log";
import type { Header, Recorder } from "./recording.ts";

const requestFor = { "http:": httpRequest, "https:": httpsRequest };

// [LAW:decomposition] The proxy never parses a body: bytes pass through in both directions as
// they arrive, which is what keeps the agent's view of the API unchanged. Every request on every
// path is recorded as it was seen; what a recording means is for its readers to decide.
export function createProxy(upstream: URL, record: Recorder): Handler {
  const request = requestFor[upstream.protocol as keyof typeof requestFor];
  // [LAW:no-silent-failure] Requests go to the upstream's origin and path, so a URL carrying anything
  // more (query, fragment, credentials) is refused here rather than forwarded to without it.
  if (!request || upstream.href !== upstream.origin + upstream.pathname)
    throw new Error(`cc-dump proxy: upstream must be an http or https origin with an optional path, got ${upstream.href}`);
  const basePath = upstream.pathname.replace(/\/$/, "");

  return (req, res, { trace_id, fail, ended }) => {
    const seen = record(trace_id);
    const headers = pairs(req.rawHeaders);
    seen({ type: "request", method: req.method!, url: req.url!, http_version: req.httpVersion, headers });
    const requestBody = (chunk: Buffer) => seen({ type: "request_body", chunk });
    // `ended` resolves in the request event's close listener, so `end` is written after the close below
    // has stopped recording both bodies: it is the exchange's last event.
    ended.then((ending) => seen({ type: "end", ...ending }));

    const outgoing = request(upstream, {
      method: req.method,
      path: basePath + req.url,
      // node adds no Host when headers are an array, so the upstream's replaces the agent's.
      headers: [["host", upstream.host], ...endToEnd(headers, towardUpstream).filter(([name]) => name.toLowerCase() !== "host")].flat(),
    });

    // An upstream failure reaches the agent as it would on a direct connection: before the
    // response started, an error response in the API's own shape; after, the cut itself.
    const upstreamFailed = (error: NodeJS.ErrnoException) => {
      fail(error);
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "application/json" }).end(apiError(upstream, error));
    };

    outgoing.on("error", upstreamFailed);
    outgoing.on("response", (incoming) => {
      const headers = pairs(incoming.rawHeaders);
      // Recorded before it is relayed, so a response node refuses to relay is recorded too.
      seen({ type: "response", status: incoming.statusCode!, reason: incoming.statusMessage!, http_version: incoming.httpVersion, headers });
      incoming.on("data", (chunk: Buffer) => seen({ type: "response_body", chunk }));
      incoming.on("error", upstreamFailed);
      // [LAW:single-enforcer] writeHead is node's check that a response can be relayed, and it is
      // stricter than node's response parser (status 099, a control byte in the reason phrase). A
      // response it refuses is cut, as the agent's own client would fail on it directly. Not a 502:
      // the refused writeHead has already written part of its state onto `res`.
      try {
        res.writeHead(incoming.statusCode!, incoming.statusMessage, endToEnd(headers, hopByHop).flat());
      } catch (error) {
        fail(error);
        return res.destroy();
      }
      incoming.pipe(res);
    });
    // [LAW:no-ambient-temporal-coupling] The exchange ends when its response closes, whether the client
    // left or the exchange is done. Nothing stays open upstream (when done, a no-op), and nothing more is
    // recorded: the agent may still be sending, and destroying `outgoing` dumps `incoming`, removing its
    // listeners.
    res.on("close", () => {
      req.off("data", requestBody);
      outgoing.destroy();
    });
    req.on("data", requestBody);
    req.pipe(outgoing);
  };
}

// RFC 9110 §7.6.1: hop-by-hop headers belong to one connection and are not forwarded, including
// any the Connection header names. The rest pass in their original case, order and repetition.
// Toward the agent, node frames the body for the agent's HTTP version.
const hopByHop = ["connection", "proxy-connection", "keep-alive", "te", "transfer-encoding", "upgrade"];
// Toward upstream, the agent's Transfer-Encoding passes: node's client frames a body only when told
// (it sends a GET body unframed), and an agent that sent chunked speaks HTTP/1.1, as node does upstream.
const towardUpstream = hopByHop.filter((name) => name !== "transfer-encoding");

function pairs(rawHeaders: string[]): Header[] {
  return rawHeaders.flatMap((name, i): Header[] => (i % 2 ? [] : [[name, rawHeaders[i + 1]!]]));
}

function endToEnd(headers: Header[], dropped: string[]): Header[] {
  const listed = headers
    .filter(([name]) => name.toLowerCase() === "connection")
    .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase()));
  const names = new Set([...dropped, ...listed]);
  return headers.filter(([name]) => !names.has(name.toLowerCase()));
}

// The Anthropic API's error body, so the agent reports the proxy's failure the way it reports the API's.
// The error's code, not its message: refusal by every address of a host is an AggregateError with none.
function apiError(upstream: URL, error: NodeJS.ErrnoException): string {
  return JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `cc-dump proxy: no valid response from ${upstream.origin}: ${error.code}` },
  });
}
