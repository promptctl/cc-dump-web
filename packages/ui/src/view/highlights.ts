import type { Range as Characters } from "./range.ts";

// The search's matches as the page paints them (docs/design/01-features.md, F6), with the CSS Custom Highlight API: a match
// is a range of a text node, painted by the stylesheet's ::highlight(match) and ::highlight(match-current). A text with
// tens of thousands of matches stays one node to lay out, where an element per match takes seconds.
// [LAW:no-shared-mutable-globals] The page's highlights are the browser's registry; this module is the one owner of
// the two the search paints, and a text adds and removes its own ranges only through `paint`.
const highlights = { match: new Highlight(), current: new Highlight() };
CSS.highlights.set("match", highlights.match);
CSS.highlights.set("match-current", highlights.current);

// Paints the matches `ranges` in the text node `node`, which holds its text's characters from `from` up to `to`, the
// one starting at `current` as the current match. A match running past the node, from one leaf of a rendering into the
// next, is painted in each as far as it holds it. Gives what removes them.
export function paint(node: Text, from: number, to: number, ranges: Characters[], current: number | undefined): () => void {
  const painted = ranges.map(({ start, end }) => {
    const range = new Range();
    range.setStart(node, Math.max(start, from) - from);
    range.setEnd(node, Math.min(end, to) - from);
    const highlight = start === current ? highlights.current : highlights.match;
    highlight.add(range);
    return { highlight, range };
  });
  return () => {
    for (const { highlight, range } of painted) highlight.delete(range);
  };
}

// The current match as painted, from where it starts: undefined while no text shown holds it. A match running across
// leaves is painted a range in each, in whatever order they painted, so it starts where the first in the document does.
// `paint` adds only Ranges.
export function currentMatch(): Range | undefined {
  return ([...highlights.current] as Range[]).reduce<Range | undefined>(
    (first, range) => (first === undefined || range.compareBoundaryPoints(Range.START_TO_START, first) < 0 ? range : first),
    undefined,
  );
}
