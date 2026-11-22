import { settingsFile } from "@cc-dump/config/settings-file";
import { launchSettingsReaders, type LaunchSettings } from "./format.ts";

// The launch settings' file, launch.json, which the app server stores as it launches. `session` is null until a launch
// names one, and the agent command `claude` until the user launches another.
export const launchSettings = settingsFile<LaunchSettings>("launch settings", launchSettingsReaders, { session: null, command: "claude" });
