import { homedir } from "node:os";
import { join } from "node:path";
import { logged, shutdownOnSignal } from "@cc-dump/log";
import { processLog } from "@cc-dump/log/lines";
import { READER_PORT } from "./address.ts";
import { runRecordingName } from "./format.ts";
import { createRecordings } from "./recordings.ts";
import { readProxySettings } from "./settings.ts";
import type { Source } from "./source.ts";
import { startProxy } from "./start.ts";
import { baseDirectory } from "@cc-dump/config/xdg";

// The proxy as `pnpm dev` runs it, running `source`. Run with plain `node`, never a watcher: the proxy must not
// restart while requests are in flight.
export async function run(source: Source) {
  const { log, logs } = processLog("proxy");

  // Its settings, from cc-dump/proxy.json under the XDG config home. Its event says which config home, which settings
  // the file set, and what the proxy took; a file it cannot take fails it, and the proxy does not start.
  const configHome = baseDirectory("XDG_CONFIG_HOME", process.env, homedir());
  const settingsPath = join(configHome.dir, "cc-dump/proxy.json");
  const { settings } = logged(
    log,
    "settings",
    { path: settingsPath, config_home_from: configHome.from, xdg_config_home: process.env.XDG_CONFIG_HOME },
    () => readProxySettings(settingsPath),
    ({ settings, file_keys }) => ({ file_keys, ...settings }),
  );

  // The recordings, one per Claude Code process, under the XDG data home; the traffic of no process goes to the run's own,
  // named for the moment the run started. Its event says which data home, and where.
  const dataHome = baseDirectory("XDG_DATA_HOME", process.env, homedir());
  const dir = join(dataHome.dir, "cc-dump/recordings");
  const run = runRecordingName(new Date());
  const recordings = logged(log, "recordings", { dir, run, data_home_from: dataHome.from, xdg_data_home: process.env.XDG_DATA_HOME }, () => createRecordings(log, dir, run));

  shutdownOnSignal(log, await startProxy(log, { upstream: settings.upstream, recordings, source, logs, proxyPort: settings.port, readerPort: READER_PORT }));
}
