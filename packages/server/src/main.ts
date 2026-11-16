import { homedir } from "node:os";
import { join } from "node:path";
import { baseDirectory } from "@cc-dump/config/xdg";
import { createLog, serve, shutdownOnSignal } from "@cc-dump/log";
import { SERVER_PORT } from "./address.ts";
import { fetchProxyInfo, requestRecording } from "./proxy.ts";
import { createApp } from "./server.ts";
import { createTerminal } from "./terminal.ts";
import { createTmux } from "./tmux.ts";

// The composition root: the app server as `pnpm dev` runs it, on the user's tmux server, beside the proxy's reader.
const log = createLog("server", (line) => process.stdout.write(line));
// The launch settings, in cc-dump/launch.json under the XDG config home, beside the proxy's settings.
const settingsPath = join(baseDirectory("XDG_CONFIG_HOME", process.env, homedir()).dir, "cc-dump/launch.json");
// The directory the app was started in, where agents start: pnpm's, which runs each part in its package's directory
// and says where it was started in INIT_CWD, or, run as a command of its own, this process's.
const directory = process.env.INIT_CWD ?? process.cwd();
const app = createApp({ log, settingsPath, tmux: createTmux(), proxyInfo: () => fetchProxyInfo(), proxyRecording: () => requestRecording(), directory });
// The pages' terminals reach the user's tmux server through the app server's port (docs/design/01-mvp.md, F13).
shutdownOnSignal(log, [await serve(log, app, SERVER_PORT, createTerminal(log))]);
