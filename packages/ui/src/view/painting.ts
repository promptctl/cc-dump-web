import { createContext, useContext, useMemo } from "react";
import type { Range } from "./range.ts";
import { find, nothing, type Searched } from "./search.ts";
import { useView } from "./state.ts";

// How a text shown in the conversation paints the search's matches (docs/design/01-mvp.md, F6), and what a block or a
// region calls when clicked. The Conversation provides both.

// How each side paints the search's matches: the right, the moment shown, with the pattern and the current match, so
// what is painted is what the search counts; the left with neither.
export type Painting = { pattern: RegExp; current: boolean };
export const unpainted: Painting = { pattern: nothing, current: false };
export const Painted = createContext<{ right: Painting; left: Painting } | undefined>(undefined);
// The side a block is shown on.
export const Side = createContext<"right" | "left">("right");

// Where a text is, `at` its address in the block `blockKey`, its matches, and where the current one starts if it is
// in this text.
export type Where = { blockKey: string; at: string; ranges: Range[]; current: number | undefined };

// A text's matches, found again only when the text or the pattern changes. A step renders again only the texts the
// current match leaves and enters.
export function useWhere(blockKey: string, at: string, searched: Searched): Where {
  const painted = useContext(Painted);
  if (painted === undefined) throw new Error("A text is shown outside a Conversation");
  const { pattern, current: paintsCurrent } = painted[useContext(Side)];
  const ranges = useMemo(() => find(pattern, searched), [pattern, searched]);
  const current = useView(({ search: { current } }) => (paintsCurrent && current !== undefined && current.key === blockKey && current.at === at ? current.start : undefined));
  return { blockKey, at, ranges, current };
}

// What a block or region calls when clicked, before it flips: the view holds where it is.
export const Hold = createContext<() => void>(() => {
  throw new Error("A block is shown outside a Conversation");
});
