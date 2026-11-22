import { createContext, useContext, useMemo } from "react";
import type { Range } from "./range.ts";
import { isOpen } from "./rows.ts";
import { find, matchIn, type ShownText } from "./search.ts";
import { useView, view } from "./state.ts";

// How a text shown in the conversation paints the search's matches (docs/design/01-features.md, F6), and what a block, a
// region, an entry of a text's contents or a sibling of a fork calls when clicked. The Conversation provides each.

// The pattern the conversation's texts paint the matches of: the search's, so what is painted is what it counts.
export const Painted = createContext<RegExp | undefined>(undefined);

// Where a text is, `at` its address in the block `blockKey`, its matches, and where the current one starts if it is
// in this text.
export type Where = { blockKey: string; at: string; ranges: Range[]; current: number | undefined };

// A text's matches, found again only when the text or the pattern changes, and the current one, by its place
// (search.ts `matchIn`). A step renders again only the texts the current match leaves and enters.
export function useWhere(blockKey: string, at: string, text: ShownText): Where {
  const pattern = useContext(Painted);
  if (pattern === undefined) throw new Error("A text is shown outside a Conversation");
  const ranges = useMemo(() => find(pattern, text.searched), [pattern, text.searched]);
  const place = useView(({ search: { current } }) => (current !== undefined && current.key === blockKey && current.at === at ? current.place : undefined));
  const current = useMemo(() => (place === undefined ? undefined : matchIn(text, ranges, place)?.start), [text, ranges, place]);
  return { blockKey, at, ranges, current };
}

// What a block or region calls when clicked, before it shows the other way: the view holds where it is.
export const Hold = createContext<() => void>(() => {
  throw new Error("A block is shown outside a Conversation");
});

// What an entry of a text's contents calls when clicked (contents.ts): the view goes to the heading drawn with the id
// `heading`, in the row of the block `blockKey`, with each of `folds` shown open.
export const ToHeading = createContext<(blockKey: string, heading: string, folds: string[]) => void>(() => {
  throw new Error("A text is shown outside a Conversation");
});

// What a sibling on a fork's line calls when clicked (rows.ts, ForkRow): the reader chooses the history that begins at
// `step`, at the fork whose line is at `fork`.
export const ToSibling = createContext<(fork: string, step: number) => void>(() => {
  throw new Error("A fork is shown outside a Conversation");
});

// Whether the sections under the headings of a block's texts start open (rows.ts, sectionsStartOpen): the block's to
// say, around its content.
export const Sections = createContext<boolean | undefined>(undefined);

// A heading's section, kept at `key`: whether it shows open, and a click's toggle of it.
export function useSection(key: string): { open: boolean; toggle: () => void } {
  const starts = useContext(Sections);
  if (starts === undefined) throw new Error("A text is shown outside a block");
  return useToggle(key, starts);
}

// [LAW:one-source-of-truth] Whether what is kept at `key`, a block, a nest, a region or a fold, which starts open or
// not as `starts` says, shows open; and a click's toggle of it: the view holds where it is, then it shows the other
// way.
export function useToggle(key: string, starts: boolean): { open: boolean; toggle: () => void } {
  const hold = useContext(Hold);
  const open = useView((state) => isOpen(state.opened, key, starts));
  return {
    open,
    toggle: () => {
      hold();
      view.toggle(key, starts);
    },
  };
}
