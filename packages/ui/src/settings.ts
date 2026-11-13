import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Category } from "./format/blocks.ts";

// Whether a category's blocks are listed (docs/design/01-mvp.md, F5). [LAW:types-are-the-program] A value, not a
// boolean, so a later level of detail is one more member, and the blocks that read it do not change ("Scaffold").
export type Visibility = "shown" | "hidden";

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, so they survive a restart of the browser. `follow`: whether follow mode is on. `visibility`: each
// category's.
export type Settings = { follow: boolean; visibility: Record<Category, Visibility> };

const name = "cc-dump.settings";

const initial: Settings = {
  follow: true,
  visibility: { user: "shown", assistant: "shown", tools: "shown", system: "shown", metadata: "shown", thinking: "shown" },
};

export const useSettings = create<Settings>()(persist((): Settings => initial, { name, storage: createJSONStorage(() => localStorage) }));

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
  setVisibility: (category: Category, visibility: Visibility) => useSettings.setState((state) => ({ visibility: { ...state.visibility, [category]: visibility } })),
  // Another tab changed what is stored under `key` (a storage event's key): the settings are read again if it was them,
  // so every tab holds the settings the reader chose last.
  changedElsewhere: (key: string | null) => {
    if (key === name) void useSettings.persist.rehydrate();
  },
};
