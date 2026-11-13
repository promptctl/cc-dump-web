import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Handler } from "@cc-dump/log";
import type { Header } from "./format.ts";
import type { Recorder } from "./recording.ts";

const requestFor = { "http:": httpRequest, "https:": httpsRequest };

declare const parsed: unique symbol;
// The address the proxy forwards to, as its href: an http or https origin with an optional path. A string, so no holder
// can change it, and branded, so `parseUpstream` alone makes one.
export type Upstream = string & { readonly [parsed]: true };

// [LAW:parse-dont-validate] [LAW:no-silent-failure] Requests go to the upstream's origin and path, so an address
// carrying anything more (query, fragment, credentials) is refused here rather than forwarded to without it.
export function parseUpstream(text: string): Upstream {
  const url = URL.canParse(text) ? new URL(text) : undefined;
  if (!url || !Object.hasOwn(requestFor, url.protocol) || url.href !== url.origin + url.pathname)
    throw new Error(`upstream must be an http or https origin with an optional path, got ${JSON.stringify(text)}`);
  return url.href as Upstream;
}

// [LAW:decomposition] The proxy never parses a body: bytes pass through in both directions as
// they arrive, which is what keeps the agent's view of the API unchanged. Every request on every
// path is recorded as it was seen; what a recording means is for its readers to decide.
export function createProxy(upstream: Upstream, record: Recorder): Handler {
  const url = new URL(upstream);
  const request = requestFor[url.protocol as keyof typeof requestFor];
  const basePath = url.pathname.replace(/\/$/, "");

  return (req, res, { trace_id, fail, ended }) => {
    const seen = record(trace_id);
    const headers = pairs(req.rawHeaders);
    seen({ type: "request", method: req.method!, url: req.url!, http_version: req.httpVersion, headers });
    const requestBody = (chunk: Buffer) => seen({ type: "request_body", chunk });
    // pipe() relays no trailers, so a body's end is relayed here: its trailers are seen, then passed on.
    const relayEnd = (from: IncomingMessage, to: OutgoingMessage, type: "request_trailers" | "response_trailers") => () => {
      const trailers = pairs(from.rawTrailers);
      seen({ type, headers: trailers });
      to.addTrailers(trailers);
      to.end();
    };
    // `ended` resolves as the response closes, and a promise's callback runs only once every close
    // listener has, the one below that stops the recording included: `end` is the exchange's last event.
    ended.then((ending) => seen({ type: "end", ...ending }));

    // An upstream failure reaches the agent as it would on a direct connection: before the
    // response started, an error response in the API's own shape; after, the cut itself.
    const upstreamFailed = (error: NodeJS.ErrnoException) => {
      fail(error);
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { "content-type": "application/json" }).end(apiError(url, error));
    };

    // [LAW:single-enforcer] node's client is its check that a request can be forwarded, and it is
    // stricter than node's server (a Trailer header on a body that is not chunked). A request it refuses
    // fails as an unreachable upstream does: nothing has been written to `res`.
    let outgoing: ClientRequest;
    try {
      outgoing = request(url, {
        method: req.method,
        path: basePath + req.url,
        // node adds no Host when headers are an array, so the upstream's replaces the agent's.
        headers: [["host", url.host], ...endToEnd(headers, towardUpstream).filter(([name]) => name.toLowerCase() !== "host")].flat(),
      });
    } catch (error) {
      return upstreamFailed(error as NodeJS.ErrnoException);
    }
    const requestEnded = relayEnd(req, outgoing, "request_trailers");

    outgoing.on("error", upstreamFailed);
    outgoing.on("response", (incoming) => {
      const responseHeaders = pairs(incoming.rawHeaders);
      // Recorded before it is relayed, so a response node refuses to relay is recorded too.
      seen({ type: "response", status: incoming.statusCode!, reason: incoming.statusMessage!, http_version: incoming.httpVersion, headers: responseHeaders });
      incoming.on("data", (chunk: Buffer) => seen({ type: "response_body", chunk }));
      incoming.on("error", upstreamFailed);
      // [LAW:single-enforcer] writeHead is node's check that a response can be relayed, and it is
      // stricter than node's response parser (status 099, a control byte in the reason phrase). A
      // response it refuses is cut, as the agent's own client would fail on it directly. Not a 502:
      // the refused writeHead has already written part of its state onto `res`.
      try {
        res.writeHead(incoming.statusCode!, incoming.statusMessage, endToEnd(responseHeaders, hopByHop).flat());
      } catch (error) {
        fail(error);
        return res.destroy();
      }
      incoming.on("end", relayEnd(incoming, res, "response_trailers"));
      incoming.pipe(res, { end: false });
    });
    // [LAW:no-ambient-temporal-coupling] The exchange ends when its response closes, whether the client
    // left or the exchange is done. Nothing stays open upstream (when done, a no-op), and nothing more is
    // recorded: the agent may still be sending, and destroying `outgoing` dumps `incoming`, removing its
    // data listeners; a destroyed stream never ends.
    res.on("close", () => {
      req.off("data", requestBody).off("end", requestEnded);
      outgoing.destroy();
    });
    req.on("data", requestBody).on("end", requestEnded);
    req.pipe(outgoing, { end: false });
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
