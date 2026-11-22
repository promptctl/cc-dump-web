import { Malformed } from "@cc-dump/log/failure";
import { levels, type Level } from "@cc-dump/log/line";
import { create } from "zustand";
import { categories, type Category } from "./format/blocks.ts";
import { boolean, keep, member, readStored, type Fields, type Item, type Read } from "./stored.ts";
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
// app and the machine; they are read as the store is made, before anything renders. `follow`: whether follow mode
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

// The settings until the reader chooses: follow on, a query a regular expression in any case, and the panels closed.
export const defaultSettings: Settings = {
  follow: true,
  visibility: defaultVisibility,
  theme: "system",
  search: { caseSensitive: false, wholeWord: false, regex: true },
  info: false,
  logs: false,
  logLevel: "info",
  keys: false,
};

// [LAW:parse-dont-validate] Each setting read on its own, so one stored as a value this build does not have is its
// default, and the others are kept.
const settingsFields: Fields<Settings> = {
  follow: boolean,
  visibility: { fields: Object.fromEntries(categories.map((category) => [category, member(visibilities)])) as Fields<Record<Category, Visibility>> },
  theme: (value, what) => {
    if (!isThemeChoice(value)) throw new Malformed(`${what}: is not a theme this build has`);
    return value;
  },
  search: { fields: { caseSensitive: boolean, wholeWord: boolean, regex: boolean } },
  info: boolean,
  logs: boolean,
  logLevel: member(levels),
  keys: boolean,
};

export const settingsItem: Item<Settings> = {
  name: "cc-dump.settings",
  fallback: defaultSettings,
  parse: (json, dropped) => keep({ fields: settingsFields }, defaultSettings, json, "settings", dropped),
  write: (settings) => settings,
};

const readSettings = () => readStored(() => globalThis.localStorage, settingsItem);
export const restoredSettings = readSettings();
export const useSettings = create<Settings>()(() => restoredSettings.value);

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
  // Another tab changed the stored settings: they are read again, so every tab holds the settings the reader chose last.
  changedElsewhere: (): Read => {
    const restored = readSettings();
    useSettings.setState(restored.value, true);
    return restored.read;
  },
};
