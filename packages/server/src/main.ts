import { createLog, serve, shutdownOnSignal } from "@cc-dump/log";
import { SERVER_PORT } from "./address.ts";
import { app } from "./server.ts";

const log = createLog("server", (line) => process.stdout.write(line));
shutdownOnSignal(log, [await serve(log, app, SERVER_PORT)]);
