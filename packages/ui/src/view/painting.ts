import { createContext, useContext, useMemo } from "react";
import type { Range } from "./range.ts";
import { isOpen } from "./rows.ts";
import { find, type Searched, type Standing } from "./search.ts";
import { useView, view } from "./state.ts";

// How a text shown in the conversation paints the search's matches (docs/design/01-features.md, F6), and what a block, a
// region, an entry of a text's contents or a sibling of a fork calls when clicked. The Conversation provides each.

// What the conversation's texts paint: the search's pattern, so what is painted is what it counts, and the current
// match as the column's judge found it standing (moves.ts `judge`), so what is painted current is what it counts from.
export type Paint = { pattern: RegExp; current: Standing | undefined };
export const Painted = createContext<Paint | undefined>(undefined);

// Where a text is, `at` its address in the block `blockKey`, its matches, and where the current one starts if it is
// in this text.
export type Where = { blockKey: string; at: string; ranges: Range[]; current: number | undefined };

// A text's matches, found again only when the text or the pattern changes, and where the current match starts, if the
// judge found it in this text. The same object while neither changes, so a text drawn from it is drawn again only when
// a step leaves it or enters it.
export function useWhere(blockKey: string, at: string, searched: Searched): Where {
  const paint = useContext(Painted);
  if (paint === undefined) throw new Error("A text is shown outside a Conversation");
  const { pattern, current } = paint;
  const ranges = useMemo(() => find(pattern, searched), [pattern, searched]);
  const start = current?.is === "found" && current.match.key === blockKey && current.match.at === at ? current.range.start : undefined;
  return useMemo(() => ({ blockKey, at, ranges, current: start }), [blockKey, at, ranges, start]);
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
