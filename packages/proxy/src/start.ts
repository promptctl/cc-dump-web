import { serve, type Log } from "@cc-dump/log";
import { json, routes, type Route } from "@cc-dump/log/answer";
import { LOOPBACK } from "@cc-dump/log/address";
import { ROUTES } from "@cc-dump/log/wire";
import type { Listing, ProxyInfo } from "./format.ts";
import { createProxy, type Upstream } from "./proxy.ts";
import { createReader } from "./reading.ts";
import type { Recordings } from "./recordings.ts";
import type { Source } from "./source.ts";
import { countTraffic, createStatus, watchSource } from "./status.ts";

// `logs`: the proxy's log lines (processLog), served on the reader port.
export type Proxying = { upstream: Upstream; recordings: Recordings; source: Source; logs: Route; proxyPort: number; readerPort: number };

// [LAW:single-enforcer] The one way the proxy is put together, for main.ts and for isolated.ts, which the tests and the
// run-cc-dump skill run as its own process: the proxy on its port, and on the reader port the proxy's status, info and log beside the recording's read side
// and the way to make a recording.
export async function startProxy(log: Log, { upstream, recordings, source, logs, proxyPort, readerPort }: Proxying) {
  const traffic = countTraffic();
  const watch = watchSource(log, source);
  const reader = createReader(log, recordings);
  // [LAW:single-enforcer] Only the agent port's requests are counted: the UI's own open reads on the reader port would
  // keep `in_flight` above 0 while the proxy is idle.
  const proxy = await serve(log, traffic.counted(createProxy(upstream, recordings)), proxyPort);
  const info: ProxyInfo = { base_url: `http://${LOOPBACK}:${proxy.port}`, upstream, recordings: recordings.dir };
  const readers = routes({
    [ROUTES.status]: { GET: createStatus(info, watch, traffic) },
    [ROUTES.info]: { GET: () => json(info) },
    [ROUTES.logs]: { GET: logs },
    [ROUTES.recordings]: { GET: reader.list, POST: createRecording(recordings) },
    [ROUTES.recording]: { GET: reader.read },
  });
  return [proxy, await serve(log, readers, readerPort)];
}

// `POST /recordings` on the reader port: makes a new agent's recording, and answers it as the list does. One it cannot
// make is the request's failure, which the app server's launch is refused by.
function createRecording(recordings: Recordings): Route {
  return () => json({ name: recordings.create() } satisfies Listing);
}
