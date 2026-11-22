import { describe, expect, it } from "vitest";
import { defaultSettings, levelAfter, readSettings, settings, settingsItem, useSettings, visibilities } from "./settings.ts";
import { stored } from "./stored.ts";
import { memoryStorage } from "./testing.ts";

describe("settings", () => {
  const chosen = {
    follow: false,
    visibility: { ...defaultSettings.visibility, user: "compact", tools: "hidden" },
    theme: "nord",
    search: { caseSensitive: true, wholeWord: false, regex: false },
    info: true,
    logs: true,
    logLevel: "warn",
    keys: true,
  } as const;

  it("keeps each setting stored, and reads one not a value this build has as its default, named", () => {
    // A level the last build stored, "shown", is not one this build has.
    expect(readSettings({ ...chosen, visibility: { ...chosen.visibility, assistant: "shown" }, search: { ...chosen.search, wholeWord: "yes" } })).toEqual({
      value: chosen,
      dropped: [
        { at: ["visibility", "assistant"], why: "is not one of hidden, compact, expanded" },
        { at: ["search", "wholeWord"], why: "is not a boolean" },
      ],
      unread: [],
    });
    expect(readSettings({ follow: "no", visibility: "hidden", theme: "a theme rich-js dropped", search: [true], logLevel: "debug", panes: 2 })).toEqual({
      value: defaultSettings,
      dropped: [
        { at: ["follow"], why: "is not a boolean" },
        { at: ["visibility"], why: "is not an object" },
        { at: ["theme"], why: "is not a theme this build has" },
        { at: ["search"], why: "is not an object" },
        { at: ["logLevel"], why: "is not one of error, warn, info" },
      ],
      unread: [{ at: ["panes"], value: 2, known: Object.keys(defaultSettings) }],
    });
  });

  it("reads the settings the build before this one stored, every choice kept", async () => {
    const { storage, writes } = memoryStorage({ "cc-dump.settings": JSON.stringify({ state: chosen, version: 0 }) });
    useSettings.persist.setOptions(stored(settingsItem(() => storage)));
    await useSettings.persist.rehydrate();
    expect(useSettings.getState()).toEqual(chosen);
    expect(writes).toEqual([]);
  });

  it("reads the settings again as another tab changes or clears them, and writes nothing back", async () => {
    const { storage, held, writes } = memoryStorage();
    useSettings.persist.setOptions(stored(settingsItem(() => storage)));
    await useSettings.persist.rehydrate();
    held.set("cc-dump.settings", JSON.stringify({ state: chosen, version: 0 }));
    settings.changedElsewhere();
    expect(useSettings.getState()).toEqual(chosen);
    held.clear();
    settings.changedElsewhere();
    expect(useSettings.getState()).toEqual(defaultSettings);
    expect(writes).toEqual([]);
  });

  it("moves a category to its next level, of more detail, and from the most back to none", () => {
    expect(visibilities.map(levelAfter)).toEqual(["compact", "expanded", "hidden"]);
  });
});
