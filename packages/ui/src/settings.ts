import { fieldOf } from "@cc-dump/log/json";
import { levels, type Level } from "@cc-dump/log/line";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { categories, type Category } from "./format/blocks.ts";
import { isThemeChoice, type ThemeChoice } from "./theme/theme.ts";

// A category's level of detail (docs/design/01-features.md, F5): its blocks not listed, `hidden`; listed, each as its line,
// `compact`; or each in full, `expanded`. In order of more detail, the order a click on the filter bar moves through.
export const visibilities = ["hidden", "compact", "expanded"] as const;
export type Visibility = (typeof visibilities)[number];

// The level a click on a category's chip, or a press of its key, moves it to from `visibility`: the next, of more
// detail, and from the most back to none.
export const levelAfter = (visibility: Visibility): Visibility => visibilities[(visibilities.indexOf(visibility) + 1) % visibilities.length]!;

// Each category's level until the reader sets one, as in the original cc-dump (src/cc_dump/core/filter_registry.py):
// what the user and the model said in full, the harness's machinery a line a block, the exchange's envelope, which the
// original listed as metadata, not at all.
export const defaultVisibility: Record<Category, Visibility> = {
  user: "expanded",
  assistant: "expanded",
  tools: "compact",
  system: "compact",
  thinking: "compact",
  parameters: "hidden",
  usage: "hidden",
  http: "hidden",
};

// How a search reads its query (docs/design/01-features.md, F6). `caseSensitive`: letters match only in the case typed.
// `wholeWord`: a match is not part of a longer word. `regex`: the query is a regular expression, not the characters it
// says. Each is on or off and no other, so the choices are independent.
export type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-features.md, F11): what they chose that outlives a tab. Kept
// in localStorage, which the browser keeps on disk under the UI's origin, so they survive a restart of the browser, the
// app and the machine; persist reads it as the store is made, before anything renders. `follow`: whether follow mode
// is on. `visibility`: each category's level. `theme`: the theme chosen (F10). `search`: how a query is read (F6).
// `info`: whether the info panel is open (F8). `logs`: whether the logs panel is open, and `logLevel`, the least a
// line it lists asks (F9). `keys`: whether the keys panel is open (view/keyboard.ts).
export type Settings = {
  follow: boolean;
  visibility: Record<Category, Visibility>;
  theme: ThemeChoice;
  search: SearchOptions;
  info: boolean;
  logs: boolean;
  logLevel: Level;
  keys: boolean;
};

const name = "cc-dump.settings";

// [LAW:parse-dont-validate] What is stored, read as the settings: each setting the stored one, or its default when none
// is stored or the one stored is not a value this build has.
export function parseSettings(stored: unknown): Settings {
  const follow = fieldOf(stored, "follow");
  const theme = fieldOf(stored, "theme");
  const info = fieldOf(stored, "info");
  const logs = fieldOf(stored, "logs");
  const logLevel = fieldOf(stored, "logLevel");
  const keys = fieldOf(stored, "keys");
  const visibility = (category: Category) => {
    const value = fieldOf(fieldOf(stored, "visibility"), category);
    return isOneOf(visibilities)(value) ? value : defaultVisibility[category];
  };
  // A query is a regular expression, in any case, until the reader chooses otherwise.
  const option = (name: keyof SearchOptions, fallback: boolean) => {
    const value = fieldOf(fieldOf(stored, "search"), name);
    return typeof value === "boolean" ? value : fallback;
  };
  return {
    follow: typeof follow === "boolean" ? follow : true,
    visibility: Object.fromEntries(categories.map((category) => [category, visibility(category)])) as Record<Category, Visibility>,
    theme: isThemeChoice(theme) ? theme : "system",
    search: { caseSensitive: option("caseSensitive", false), wholeWord: option("wholeWord", false), regex: option("regex", true) },
    info: typeof info === "boolean" ? info : false,
    logs: typeof logs === "boolean" ? logs : false,
    logLevel: isOneOf(levels)(logLevel) ? logLevel : "info",
    keys: typeof keys === "boolean" ? keys : false,
  };
}

// Whether a stored value is one of `values`.
const isOneOf = <T,>(values: readonly T[]) => (value: unknown): value is T => (values as readonly unknown[]).includes(value);

export const useSettings = create<Settings>()(
  persist(() => parseSettings(undefined), { name, storage: createJSONStorage(() => localStorage), merge: (stored) => parseSettings(stored) }),
);

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
  setSearchOption: (option: keyof SearchOptions, on: boolean) => useSettings.setState((state) => ({ search: { ...state.search, [option]: on } })),
  setTheme: (theme: ThemeChoice) => useSettings.setState({ theme }),
  setInfo: (info: boolean) => useSettings.setState({ info }),
  setLogs: (logs: boolean) => useSettings.setState({ logs }),
  setLogLevel: (logLevel: Level) => useSettings.setState({ logLevel }),
  setKeys: (keys: boolean) => useSettings.setState({ keys }),
  // [LAW:single-enforcer] A category moved to its next level, by a click on its chip or a press of its key.
  stepVisibility: (category: Category) => useSettings.setState((state) => ({ visibility: { ...state.visibility, [category]: levelAfter(state.visibility[category]) } })),
  // Another tab changed what is stored under `key` (a storage event's key): the settings are read again if it was them,
  // so every tab holds the settings the reader chose last.
  changedElsewhere: (key: string | null) => {
    if (key === name) void useSettings.persist.rehydrate();
  },
};
