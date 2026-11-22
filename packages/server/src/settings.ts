import { settingsFile } from "@cc-dump/config/settings-file";
import { launchSettingsDefaults, launchSettingsReaders } from "./format.ts";

// The launch settings' file, launch.json, which the app server stores as it launches.
export const launchSettings = settingsFile("launch settings", launchSettingsReaders, launchSettingsDefaults);
