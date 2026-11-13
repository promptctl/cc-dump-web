import { createServer, type Server } from "node:http";
import { withRequestEvent, type Log } from "@cc-dump/log";

// The app server restarts on every source change, so it holds nothing that must survive one.
export function createAppServer(log: Log): Server {
  return createServer(withRequestEvent(log, (_req, res) => res.writeHead(404).end()));
}
