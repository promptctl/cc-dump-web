import { fieldOf } from "@cc-dump/log/json";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { categories, type Category } from "./format/blocks.ts";
import { isThemeChoice, type ThemeChoice } from "./theme/theme.ts";

// Whether a category's blocks are listed (docs/design/01-mvp.md, F5). [LAW:types-are-the-program] A value, not a
// boolean, so a later level of detail is one more member ("Scaffold").
export const visibilities = ["shown", "hidden"] as const;
export type Visibility = (typeof visibilities)[number];

// How a search reads its query (docs/design/01-mvp.md, F6). `caseSensitive`: letters match only in the case typed.
// `wholeWord`: a match is not part of a longer word. `regex`: the query is a regular expression, not the characters it
// says. Each is on or off and no other, so the choices are independent.
export type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean };

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, which the browser keeps on disk under the UI's origin, so they survive a restart of the browser, the
// app and the machine; persist reads it as the store is made, before anything renders. `follow`: whether follow mode
// is on. `visibility`: each category's. `theme`: the theme chosen (F10). `search`: how a query is read (F6).
export type Settings = { follow: boolean; visibility: Record<Category, Visibility>; theme: ThemeChoice; search: SearchOptions };

const name = "cc-dump.settings";

// [LAW:parse-dont-validate] What is stored, read as the settings: each setting the stored one, or its default when none
// is stored or the one stored is not a value this build has.
export function parseSettings(stored: unknown): Settings {
  const follow = fieldOf(stored, "follow");
  const theme = fieldOf(stored, "theme");
  const visibility = (category: Category) => {
    const value = fieldOf(fieldOf(stored, "visibility"), category);
    return isVisibility(value) ? value : "shown";
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
  };
}

const isVisibility = (value: unknown): value is Visibility => (visibilities as readonly unknown[]).includes(value);

export const useSettings = create<Settings>()(
  persist(() => parseSettings(undefined), { name, storage: createJSONStorage(() => localStorage), merge: (stored) => parseSettings(stored) }),
);

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
  setSearchOption: (option: keyof SearchOptions, on: boolean) => useSettings.setState((state) => ({ search: { ...state.search, [option]: on } })),
  setTheme: (theme: ThemeChoice) => useSettings.setState({ theme }),
  setVisibility: (category: Category, visibility: Visibility) => useSettings.setState((state) => ({ visibility: { ...state.visibility, [category]: visibility } })),
  // Another tab changed what is stored under `key` (a storage event's key): the settings are read again if it was them,
  // so every tab holds the settings the reader chose last.
  changedElsewhere: (key: string | null) => {
    if (key === name) void useSettings.persist.rehydrate();
  },
};
