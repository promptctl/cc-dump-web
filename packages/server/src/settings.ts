import { settingsFile } from "@cc-dump/config/settings-file";
import { launchSettingsTable } from "./format.ts";

// The launch settings' file, launch.json, which the app server stores as it launches.
export const launchSettings = settingsFile("launch settings", launchSettingsTable);
