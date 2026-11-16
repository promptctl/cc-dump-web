import { describe, expect, it } from "vitest";
import { parseSettings } from "./settings.ts";

describe("settings", () => {
  const defaults = { follow: true, visibility: { user: "expanded", assistant: "expanded", tools: "compact", system: "compact", metadata: "hidden", thinking: "compact" },
    theme: "system",
    search: { caseSensitive: false, wholeWord: false, regex: true },
    unchanged: "fold",
    branches: "stay",
    info: false,
    logs: false,
    logLevel: "info",
  };

  it("reads nothing stored as every setting's default", () => {
    expect(parseSettings(undefined)).toEqual(defaults);
    expect(parseSettings(null)).toEqual(defaults);
  });

  it("keeps each setting stored, and reads one missing or not a value this build has as its default", () => {
    expect(
      parseSettings({ follow: false, visibility: { user: "compact", tools: "hidden", system: "summary", metadata: 1, thinking: "expanded", assistant: "shown" }, theme: "nord", search: { caseSensitive: true, wholeWord: "yes", regex: false }, unchanged: "show", branches: "fold", info: true, logs: true, logLevel: "warn" }),
    ).toEqual({
      follow: false,
      // A level the last build stored, "shown", is not one this build has.
      visibility: { ...defaults.visibility, user: "compact", tools: "hidden", thinking: "expanded" },
      theme: "nord",
      search: { caseSensitive: true, wholeWord: false, regex: false },
      unchanged: "show",
      branches: "fold",
      info: true,
      logs: true,
      logLevel: "warn",
    });
    expect(
      parseSettings({ follow: "no", visibility: "hidden", theme: "a theme rich-js dropped", search: [true], unchanged: "hide", branches: "everywhere", info: "open", logs: 1, logLevel: "debug" }),
    ).toEqual(defaults);
  });
});
