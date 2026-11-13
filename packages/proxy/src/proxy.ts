import { createServer, type Server } from "node:http";
import { withRequestEvent, type Log } from "@cc-dump/log";

export function createProxy(log: Log): Server {
  return createServer(
    withRequestEvent(log, (_req, res) => {
      res.writeHead(501, { "content-type": "text/plain" }).end("cc-dump proxy: forwarding not built yet\n");
    }),
  );
}
