import { settingsFile } from "@cc-dump/config/settings-file";
import { commandLine, sessionName } from "./format.ts";

// [LAW:one-source-of-truth] The launch settings (docs/design/01-mvp.md, F1, F11): the settings the last launch was
// made with, which the app server stores as it launches. The agent command is a whole command line, `claude` until the
// user launches another.
export const launchSettings = settingsFile("launch settings", {
  session: { default: null, parse: (value: unknown) => (value === null ? null : sessionName(value)) },
  command: { default: "claude", parse: commandLine },
});
