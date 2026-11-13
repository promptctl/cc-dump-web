import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { OpenRecording } from "../reading.ts";
import type { Position } from "./position.ts";
import { isExpanded } from "./rows.ts";
import type { Match, Step } from "./search.ts";

// [LAW:one-source-of-truth] What the reader has chosen about the view: the recording open, each block or region they
// flipped from how it starts, by key, where they are, and their search. Everything else on screen is derived from the events and the
// settings. It is kept for the tab in sessionStorage, so after a hot reload or a page reload the view is the same
// (docs/design/01-mvp.md, F12). A tab opens at the end, which follows the conversation while follow is on. While it is
// off, the end becomes the place under the view at the first step.
// [LAW:types-are-the-program] A flip is a key's presence, so a block flipped back is no entry, not one that says its
// default.
export type View = { open: OpenRecording; flipped: Record<string, true>; position: Position; search: Search };

// The search: its query, and the match last stepped to, the one holder of which match is current. A new query has none.
export type Search = { query: string; current: Match | undefined };

export const useView = create<View>()(
  persist((): View => ({ open: { recording: "live" }, flipped: {}, position: { at: "end" }, search: { query: "", current: undefined } }), {
    name: "cc-dump.view",
    storage: createJSONStorage(() => sessionStorage),
  }),
);

export const view = {
  // A recording opened is shown as a tab opens, at its end, with no current match: the one there was is the last
  // recording's. Flips are kept: a row's key begins with its exchange's trace_id, so none is another recording's.
  open: (open: OpenRecording) => useView.setState(({ search }) => ({ open, position: { at: "end" }, search: { ...search, current: undefined } })),
  toggle: (key: string) => useView.setState(({ flipped }) => ({ flipped: flip(flipped, key) })),
  moveTo: (position: Position) => useView.setState({ position }),
  search: (query: string) => useView.setState({ search: { query, current: undefined } }),
  // A step to a match: it becomes current, its block and the regions holding it show expanded, and the view moves to
  // its row, which the step then refines to the match's line.
  goTo: ({ match, block, regions }: Step) =>
    useView.setState(({ flipped, search }) => {
      const opened = block === undefined || isExpanded(flipped, block) ? flipped : flip(flipped, block.key);
      return {
        flipped: { ...opened, ...Object.fromEntries(regions.map((key) => [key, true] as const)) },
        position: { at: "row", key: match.key, offset: 0 },
        search: { ...search, current: match },
      };
    }),
};

// The flips with `key` flipped.
function flip(flipped: Record<string, true>, key: string): Record<string, true> {
  const { [key]: was, ...rest } = flipped;
  return was ? rest : { ...rest, [key]: true };
}
