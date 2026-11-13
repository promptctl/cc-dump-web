import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, so they survive a restart of the browser. `follow`: whether follow mode is on.
export type Settings = { follow: boolean };

export const useSettings = create<Settings>()(persist((): Settings => ({ follow: true }), { name: "cc-dump.settings", storage: createJSONStorage(() => localStorage) }));

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
};
