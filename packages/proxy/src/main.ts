import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createLog, logged, serve, shutdownOnSignal } from "@cc-dump/log";
import { PROXY_PORT, READER_PORT, UPSTREAM } from "./address.ts";
import { createProxy } from "./proxy.ts";
import { createReader } from "./reading.ts";
import { createRecording } from "./recording.ts";

// Run with plain `node`, never a watcher: the proxy must not restart while requests are in flight.
const log = createLog("proxy", (line) => process.stdout.write(line));

// One recording per run, named for the moment the run started in ISO 8601 basic format (no colons, which
// Finder and Windows refuse), under the XDG Base Directory data home: $XDG_DATA_HOME, or the spec's
// default when that is unset or not absolute, which the spec says to ignore. Its event says which, and where.
const xdg = process.env.XDG_DATA_HOME;
const dataHome = xdg && isAbsolute(xdg) ? { dir: xdg, from: "XDG_DATA_HOME" } : { dir: join(homedir(), ".local/share"), from: "default" };
const path = join(dataHome.dir, "cc-dump/recordings", `${new Date().toISOString().replace(/[-:]/g, "")}.jsonl`);
const recording = logged(log, "recording", { path, data_home_from: dataHome.from, xdg_data_home: xdg }, () => createRecording(log, path));

shutdownOnSignal(log, [
  await serve(log, createProxy(new URL(UPSTREAM), recording.record), PROXY_PORT),
  await serve(log, createReader(log, recording), READER_PORT),
]);
