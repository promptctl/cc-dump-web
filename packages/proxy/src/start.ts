import { serve, type Handler, type Log } from "@cc-dump/log";
import { LOOPBACK } from "@cc-dump/log/address";
import type { Listing, ProxyInfo } from "./format.ts";
import { createProxy, type Upstream } from "./proxy.ts";
import { createReader } from "./reading.ts";
import type { Recordings } from "./recordings.ts";
import type { Source } from "./source.ts";
import { countTraffic, createStatus, watchSource } from "./status.ts";

export type Proxying = { upstream: Upstream; recordings: Recordings; source: Source; proxyPort: number; readerPort: number };

// [LAW:single-enforcer] The one way the proxy is put together, for main.ts and for isolated.ts, which the tests and the
// run-cc-dump skill run as its own process: the proxy on its port, and on the reader port the proxy's status and info beside the recording's read side
// and the way to make a recording.
export async function startProxy(log: Log, { upstream, recordings, source, proxyPort, readerPort }: Proxying) {
  const traffic = countTraffic();
  const watch = watchSource(log, source);
  const reader = createReader(log, recordings);
  const proxy = await serve(log, traffic.counted(createProxy(upstream, recordings)), proxyPort);
  const info: ProxyInfo = { base_url: `http://${LOOPBACK}:${proxy.port}`, upstream, recordings: recordings.dir };
  const routes: Record<string, Handler> = {
    "/status": createStatus(info, watch, traffic),
    "/info": createInfo(info),
    "/recordings": byMethod({ GET: reader, POST: createRecording(recordings) }),
  };
  const readers: Handler = (req, res, work) => {
    // [LAW:single-enforcer] Every answer on the reader port, any route's: the browser's origin is the UI's, not the
    // proxy's, and security is a non-goal (docs/design/01-mvp.md).
    res.setHeader("access-control-allow-origin", "*");
    (routes[new URL(req.url!, "http://reader").pathname] ?? reader)(req, res, work);
  };
  return [proxy, await serve(log, readers, readerPort)];
}

// `GET /info` on the reader port: `info`, as JSON.
function createInfo(info: ProxyInfo): Handler {
  return (req, res) => {
    if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info));
  };
}

// `POST /recordings` on the reader port: makes the recording of an agent about to launch, and answers it as the list
// does. One it cannot make is the request's failure, which the app server's launch is refused by.
function createRecording(recordings: Recordings): Handler {
  return (_req, res, { fail }) => {
    try {
      const created: Listing = { name: recordings.create() };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(created));
    } catch (error) {
      fail(error);
      res.writeHead(500).end();
    }
  };
}

// A route that gives each method of `handlers` its handler, and any other 405, naming them.
function byMethod(handlers: Record<string, Handler>): Handler {
  const allow = Object.keys(handlers).join(", ");
  return (req, res, work) => {
    const handler = handlers[req.method!];
    return handler === undefined ? void res.writeHead(405, { allow }).end() : handler(req, res, work);
  };
}
