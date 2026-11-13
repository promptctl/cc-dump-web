import { homedir } from "node:os";
import { join } from "node:path";
import { createLog, logged, shutdownOnSignal } from "@cc-dump/log";
import { READER_PORT } from "./address.ts";
import { createRecording } from "./recording.ts";
import { readProxySettings } from "./settings.ts";
import type { Source } from "./source.ts";
import { startProxy } from "./start.ts";
import { baseDirectory } from "./xdg.ts";

// The proxy as `pnpm dev` runs it, running `source`. Run with plain `node`, never a watcher: the proxy must not
// restart while requests are in flight.
export async function run(source: Source) {
  const log = createLog("proxy", (line) => process.stdout.write(line));

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

  // One recording per run, named for the moment the run started in ISO 8601 basic format (no colons, which
  // Finder and Windows refuse), under the XDG data home. Its event says which data home, and where.
  const dataHome = baseDirectory("XDG_DATA_HOME", process.env, homedir());
  const path = join(dataHome.dir, "cc-dump/recordings", `${new Date().toISOString().replace(/[-:]/g, "")}.jsonl`);
  const recording = logged(log, "recording", { path, data_home_from: dataHome.from, xdg_data_home: process.env.XDG_DATA_HOME }, () => createRecording(log, path));

  shutdownOnSignal(log, await startProxy(log, { upstream: settings.upstream, recording, source, proxyPort: settings.port, readerPort: READER_PORT }));
}
