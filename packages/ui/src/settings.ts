import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, so they survive a restart of the browser. `follow`: whether follow mode is on.
export type Settings = { follow: boolean };

const name = "cc-dump.settings";

export const useSettings = create<Settings>()(persist((): Settings => ({ follow: true }), { name, storage: createJSONStorage(() => localStorage) }));

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
  // Another tab changed what is stored under `key` (a storage event's key): the settings are read again if it was them,
  // so every tab holds the settings the reader chose last.
  changedElsewhere: (key: string | null) => {
    if (key === name) void useSettings.persist.rehydrate();
  },
};
