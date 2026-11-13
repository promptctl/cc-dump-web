import { createLog, listen } from "@cc-dump/log";
import { PROXY_PORT, UPSTREAM } from "./address.ts";
import { createProxy } from "./proxy.ts";

// Run with plain `node`, never a watcher: the proxy must not restart while requests are in flight.
const log = createLog("proxy", (line) => process.stdout.write(line));
await listen(log, createProxy(log, new URL(UPSTREAM)), PROXY_PORT);
