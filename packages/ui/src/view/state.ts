import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Position } from "./position.ts";

// [LAW:one-source-of-truth] What the reader has chosen about the view: each block or region they expanded or collapsed
// against its default, by key, and where they are. Everything else on screen is derived from the events. It is kept
// for the tab in sessionStorage, so after a hot reload or a page reload the view is the same (docs/design/01-mvp.md, F12).
export type View = { toggled: Record<string, boolean>; position: Position };

export const useView = create<View>()(
  persist((): View => ({ toggled: {}, position: { at: "start" } }), { name: "cc-dump.view", storage: createJSONStorage(() => sessionStorage) }),
);

export const view = {
  toggle: (key: string, expanded: boolean) => useView.setState(({ toggled }) => ({ toggled: { ...toggled, [key]: !expanded } })),
  moveTo: (position: Position) => useView.setState({ position }),
};
