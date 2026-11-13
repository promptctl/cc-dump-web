import { serve, type Handler, type Log } from "@cc-dump/log";
import { createProxy } from "./proxy.ts";
import { createReader } from "./reading.ts";
import type { Recording } from "./recording.ts";
import type { Source } from "./source.ts";
import { createStatus, watchSource } from "./status.ts";

export type Proxying = { upstream: URL; recording: Recording; source: Source; proxyPort: number; readerPort: number };

// [LAW:single-enforcer] The one way the proxy is put together, for main.ts and for the tests that run it as its own
// process: the proxy on its port, and on the reader port the proxy's status beside the recording's read side.
export async function startProxy(log: Log, { upstream, recording, source, proxyPort, readerPort }: Proxying) {
  const status = createStatus(watchSource(log, source));
  const reader = createReader(log, recording);
  const readers: Handler = (req, res, work) => {
    // [LAW:single-enforcer] Every answer on the reader port, any route's: the browser's origin is the UI's, not the
    // proxy's, and security is a non-goal (docs/design/01-mvp.md).
    res.setHeader("access-control-allow-origin", "*");
    (new URL(req.url!, "http://reader").pathname === "/status" ? status : reader)(req, res, work);
  };
  return [await serve(log, createProxy(upstream, recording.record), proxyPort), await serve(log, readers, readerPort)];
}
