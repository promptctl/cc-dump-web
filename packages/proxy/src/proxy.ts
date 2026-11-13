import { request as httpRequest, createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { withRequestEvent, type Log } from "@cc-dump/log";

const requestFor = { "http:": httpRequest, "https:": httpsRequest };

// [LAW:decomposition] The proxy never parses a body: bytes pass through in both directions as
// they arrive, which is what keeps the agent's view of the API unchanged.
export function createProxy(log: Log, upstream: URL): Server {
  const request = requestFor[upstream.protocol as keyof typeof requestFor];
  if (!request) throw new Error(`cc-dump proxy: upstream must be http or https, got ${upstream.href}`);
  const basePath = upstream.pathname.replace(/\/$/, "");

  return createServer(
    withRequestEvent(log, (req, res, fail) => {
      const outgoing = request(upstream, {
        method: req.method,
        path: basePath + req.url,
        // node adds no Host when headers are an array, so the upstream's replaces the agent's.
        headers: [["host", upstream.host], ...endToEnd(req.rawHeaders).filter(([name]) => name.toLowerCase() !== "host")].flat(),
      });

      // An upstream failure reaches the agent as it would on a direct connection: before the
      // response started, an error response in the API's own shape; after, the cut itself.
      const upstreamFailed = (error: Error) => {
        fail(error);
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { "content-type": "application/json" }).end(apiError(upstream, error));
      };

      outgoing.on("error", upstreamFailed);
      outgoing.on("response", (incoming) => {
        incoming.on("error", upstreamFailed);
        res.writeHead(incoming.statusCode!, incoming.statusMessage, endToEnd(incoming.rawHeaders).flat());
        incoming.pipe(res);
      });
      // The client left, or the exchange is done (then this is a no-op): nothing stays open upstream.
      res.on("close", () => outgoing.destroy());
      req.pipe(outgoing);
    }),
  );
}

type Header = [name: string, value: string];

// RFC 9110 §7.6.1: hop-by-hop headers belong to one connection and are not forwarded, including
// any the Connection header names. The rest pass in their original case, order and repetition.
const hopByHop = ["connection", "proxy-connection", "keep-alive", "te", "transfer-encoding", "upgrade"];

function endToEnd(rawHeaders: string[]): Header[] {
  const headers = rawHeaders.flatMap((name, i): Header[] => (i % 2 ? [] : [[name, rawHeaders[i + 1]!]]));
  const listed = headers
    .filter(([name]) => name.toLowerCase() === "connection")
    .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase()));
  const dropped = new Set([...hopByHop, ...listed]);
  return headers.filter(([name]) => !dropped.has(name.toLowerCase()));
}

// The Anthropic API's error body, so the agent reports the proxy's failure the way it reports the API's.
function apiError(upstream: URL, error: Error): string {
  return JSON.stringify({
    type: "error",
    error: { type: "api_error", message: `cc-dump proxy: ${upstream.origin} unreachable: ${error.message}` },
  });
}
