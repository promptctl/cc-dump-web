import { useLayoutEffect, useMemo, useRef } from "react";
import { paint } from "./highlights.ts";
import { useWhere, type Where } from "./painting.ts";
import { rangesIn, whole, type Address } from "./search.ts";

// A whole text, its matches highlighted.
export function HighlightedText({ blockKey, at, text }: { blockKey: string; at: Address; text: string }) {
  return <Highlighted slice={text} from={0} where={useWhere(blockKey, at, useMemo(() => whole(text), [text]))} />;
}

// A slice of a text, starting at `from` in it: a leaf of its rendering. Its matches are highlighted, as much of each as
// it holds, and the current one highlighted apart.
export function Highlighted({ slice, from, where: { ranges, current } }: { slice: string; from: number; where: Where }) {
  const span = useRef<HTMLSpanElement>(null);
  const to = from + slice.length;
  const held = useMemo(() => rangesIn(ranges, from, to), [ranges, from, to]);
  // The current match if this slice holds any of it, so a step paints again only the slices it leaves and enters.
  const own = held.some(({ start }) => start === current) ? current : undefined;
  // An empty slice has no text node, and holds no match to paint in one.
  useLayoutEffect(() => paint(span.current!.firstChild as Text, from, to, held, own), [from, to, held, own]);
  return <span ref={span}>{slice}</span>;
}
