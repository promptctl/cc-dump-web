import { createLog, serve } from "@cc-dump/log";
import { SERVER_PORT } from "./address.ts";
import { app } from "./server.ts";

const log = createLog("server", (line) => process.stdout.write(line));
await serve(log, app, SERVER_PORT);
