import { describe, expect, it } from "vitest";
import { parseSettings } from "./settings.ts";

describe("settings", () => {
  const defaults = { follow: true, visibility: { user: "shown", assistant: "shown", tools: "shown", system: "shown", metadata: "shown", thinking: "shown" }, theme: "system" };

  it("reads nothing stored as every setting's default", () => {
    expect(parseSettings(undefined)).toEqual(defaults);
    expect(parseSettings(null)).toEqual(defaults);
  });

  it("keeps each setting stored, and reads one missing or not a value this build has as its default", () => {
    expect(parseSettings({ follow: false, visibility: { tools: "hidden", system: "summary", metadata: 1 }, theme: "nord" })).toEqual({
      follow: false,
      visibility: { ...defaults.visibility, tools: "hidden" },
      theme: "nord",
    });
    expect(parseSettings({ follow: "no", visibility: "hidden", theme: "a theme rich-js dropped" })).toEqual(defaults);
  });
});
