import { describe, expect, it } from "vitest";
import { defaultSettings, levelAfter, settingsItem, visibilities } from "./settings.ts";
import { readStored } from "./stored.ts";
import { memoryStorage } from "./testing.ts";

const reread = (json: unknown) => readStored(() => memoryStorage({ [settingsItem.name]: JSON.stringify(json) }), settingsItem);

describe("settings", () => {
  it("are each setting's default until the reader chooses", () => {
    expect(defaultSettings).toEqual({
      follow: true,
      visibility: { user: "expanded", assistant: "expanded", tools: "compact", system: "compact", thinking: "compact", parameters: "hidden", usage: "hidden", http: "hidden" },
      theme: "system",
      search: { caseSensitive: false, wholeWord: false, regex: true },
      info: false,
      logs: false,
      logLevel: "info",
      keys: false,
    });
    expect(readStored(() => memoryStorage(), settingsItem)).toEqual({ value: defaultSettings, read: { stored: "none" } });
  });

  it("keep each setting stored, and read one not a value this build has as its default, naming it", () => {
    const stored = { ...defaultSettings, follow: false, theme: "nord", logLevel: "warn", search: { caseSensitive: true, wholeWord: "yes", regex: false } };
    // A level the last build stored, "shown", is not one this build has.
    const restored = reread({ ...stored, visibility: { ...defaultSettings.visibility, user: "compact", assistant: "shown" } });
    expect(restored.value).toEqual({ ...stored, visibility: { ...defaultSettings.visibility, user: "compact" }, search: { caseSensitive: true, wholeWord: false, regex: false } });
    expect(Object.keys(restored.read.stored === "read" ? restored.read.dropped : {})).toEqual(["settings.visibility.assistant", "settings.search.wholeWord"]);
    expect(reread({ ...defaultSettings, theme: "a theme rich-js dropped" }).read).toEqual({
      stored: "read",
      dropped: { "settings.theme": "settings.theme: is not a theme this build has" },
    });
  });

  it("move a category to its next level, of more detail, and from the most back to none", () => {
    expect(visibilities.map(levelAfter)).toEqual(["compact", "expanded", "hidden"]);
  });
});
