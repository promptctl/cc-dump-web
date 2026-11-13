import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { categories, type Category } from "./format/blocks.ts";

// Whether a category's blocks are listed (docs/design/01-mvp.md, F5). [LAW:types-are-the-program] A value, not a
// boolean, so a later level of detail is one more member, and the blocks that read it do not change ("Scaffold").
export const visibilities = ["shown", "hidden"] as const;
export type Visibility = (typeof visibilities)[number];

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, so they survive a restart of the browser. `follow`: whether follow mode is on. `visibility`: each
// category's.
export type Settings = { follow: boolean; visibility: Record<Category, Visibility> };

const name = "cc-dump.settings";

// [LAW:parse-dont-validate] What is stored, read as the settings: each setting the stored one, or its default when none
// is stored or the one stored is not a value this build has, as one an older or a newer build wrote.
export function parseSettings(stored: unknown): Settings {
  const follow = field(stored, "follow");
  const visibility = (category: Category) => {
    const value = field(field(stored, "visibility"), category);
    return isVisibility(value) ? value : "shown";
  };
  return {
    follow: typeof follow === "boolean" ? follow : true,
    visibility: Object.fromEntries(categories.map((category) => [category, visibility(category)])) as Record<Category, Visibility>,
  };
}

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);
const isVisibility = (value: unknown): value is Visibility => (visibilities as readonly unknown[]).includes(value);

export const useSettings = create<Settings>()(
  persist(() => parseSettings(undefined), { name, storage: createJSONStorage(() => localStorage), merge: (stored) => parseSettings(stored) }),
);

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
  setVisibility: (category: Category, visibility: Visibility) => useSettings.setState((state) => ({ visibility: { ...state.visibility, [category]: visibility } })),
  // Another tab changed what is stored under `key` (a storage event's key): the settings are read again if it was them,
  // so every tab holds the settings the reader chose last.
  changedElsewhere: (key: string | null) => {
    if (key === name) void useSettings.persist.rehydrate();
  },
};
