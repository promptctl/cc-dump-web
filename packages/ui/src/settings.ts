import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// [LAW:one-source-of-truth] The reader's settings (docs/design/01-mvp.md, F11): what they chose that outlives a tab. Kept
// in localStorage, so they survive a restart of the browser. `follow`: whether follow mode is on.
export type Settings = { follow: boolean };

const name = "cc-dump.settings";

export const useSettings = create<Settings>()(persist((): Settings => ({ follow: true }), { name, storage: createJSONStorage(() => localStorage) }));

// Another tab's change arrives as a storage event, so every tab holds the setting the reader chose last.
window.addEventListener("storage", (event) => {
  if (event.key === name) void useSettings.persist.rehydrate();
});

export const settings = {
  setFollow: (follow: boolean) => useSettings.setState({ follow }),
};
