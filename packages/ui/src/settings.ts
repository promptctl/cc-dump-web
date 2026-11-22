import { kinds, tolerant, value, type Read, type Readers } from "@cc-dump/log/json";
import { levels, type Level } from "@cc-dump/log/line";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { categories, type Category } from "./format/blocks.ts";
import { stored, type Item } from "./stored.ts";
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
// app and the machine; persist reads it as the store is made, before anything renders (stored.ts). `follow`: whether follow mode
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

// Each setting until the reader chooses: follow mode on, a query a regular expression in any case, the panels closed.
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

const boolean = value(kinds.boolean);
// [LAW:types-are-the-program] One reader for each category, as `categories` lists them, which is what
// `Record<Category, Visibility>` holds.
const visibility = Object.fromEntries(categories.map((category) => [category, value(kinds.among(visibilities))])) as Readers<Record<Category, Visibility>>;

// [LAW:parse-dont-validate] Settings as stored, read as this build reads them: each setting, and each category's level
// and each way of reading a query, the one stored, or its default where none is stored or the one stored is not a value
// this build has, which is named.
const settingsReader = tolerant<Settings>(
  {
    follow: boolean,
    visibility: tolerant(visibility, defaultVisibility),
    theme: value({ fits: isThemeChoice, expected: "a theme this build has" }),
    search: tolerant<SearchOptions>({ caseSensitive: boolean, wholeWord: boolean, regex: boolean }, defaultSettings.search),
    info: boolean,
    logs: boolean,
    logLevel: value(kinds.among(levels)),
    keys: boolean,
  },
  defaultSettings,
);
export const readSettings = (state: unknown): Read<Settings> => settingsReader(state, []);

// The settings as the browser keeps them, in localStorage, in `storage` for a test. Stored at persist's first version,
// as every build has stored them, and read alike under any.
export const settingsItem = (storage: () => Storage): Item<Settings> => ({ name: "cc-dump.settings", version: 0, storage, initial: defaultSettings, read: readSettings });
export const storedSettings = settingsItem(() => localStorage);

export const useSettings = create<Settings>()(persist(() => defaultSettings, stored(storedSettings)));

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
  // Another tab changed the settings, or cleared their storage (main.tsx tells which): they are read again, so every tab
  // holds the settings the reader chose last. The read writes nothing (stored.ts).
  changedElsewhere: () => void useSettings.persist.rehydrate(),
};
