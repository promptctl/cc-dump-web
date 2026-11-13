import { createLog, listen } from "@cc-dump/log";
import { SERVER_PORT } from "./address.ts";
import { createAppServer } from "./server.ts";

const log = createLog("server", (line) => process.stdout.write(line));
await listen(log, createAppServer(log), SERVER_PORT);
