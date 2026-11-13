import { homedir } from "node:os";
import { join } from "node:path";
import { createLog, logged, serve } from "@cc-dump/log";
import { PROXY_PORT, UPSTREAM } from "./address.ts";
import { createProxy } from "./proxy.ts";
import { createRecording } from "./recording.ts";

// Run with plain `node`, never a watcher: the proxy must not restart while requests are in flight.
const log = createLog("proxy", (line) => process.stdout.write(line));

// One recording per run, named for the moment the run started, under the XDG Base Directory data home:
// $XDG_DATA_HOME, or the spec's default when that is unset or empty. Its event says which, and where.
const xdg = process.env.XDG_DATA_HOME;
const dataHome = xdg ? { dir: xdg, from: "XDG_DATA_HOME" } : { dir: join(homedir(), ".local/share"), from: "default" };
const path = join(dataHome.dir, "cc-dump/recordings", `${new Date().toISOString()}.jsonl`);
const record = logged(log, "recording", { path, data_home_from: dataHome.from }, () => createRecording(log, path));

await serve(log, createProxy(new URL(UPSTREAM), record), PROXY_PORT);
