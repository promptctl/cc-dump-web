import { settingsFile } from "@cc-dump/config/settings-file";
import { launchSettings } from "./format.ts";

// The launch settings' file, launch.json, which the app server stores as it launches.
export const launchSettingsFile = settingsFile("launch settings", launchSettings);
