import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Position } from "./position.ts";

// [LAW:one-source-of-truth] What the reader has chosen about the view: each block or region they flipped from how it
// starts, by key, and where they are. Everything else on screen is derived from the events. It is kept for the tab in
// sessionStorage, so after a hot reload or a page reload the view is the same (docs/design/01-mvp.md, F12).
// [LAW:types-are-the-program] A flip is a key's presence, so a block flipped back is no entry, not one that says its
// default.
export type View = { flipped: Record<string, true>; position: Position };

export const useView = create<View>()(
  persist((): View => ({ flipped: {}, position: { at: "start" } }), { name: "cc-dump.view", storage: createJSONStorage(() => sessionStorage) }),
);

export const view = {
  toggle: (key: string) =>
    useView.setState(({ flipped }) => {
      const { [key]: was, ...rest } = flipped;
      return { flipped: was ? rest : { ...rest, [key]: true } };
    }),
  moveTo: (position: Position) => useView.setState({ position }),
};
