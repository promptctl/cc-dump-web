import type { Range as Characters } from "./search.ts";

// The search's matches as the page paints them (docs/design/01-mvp.md, F6), with the CSS Custom Highlight API: a match
// is a range of a text node, painted by the stylesheet's ::highlight(match) and ::highlight(match-current). A text with
// tens of thousands of matches stays one node to lay out, where an element per match takes seconds.
// [LAW:no-shared-mutable-globals] The page's highlights are the browser's registry; this module is the one owner of
// the two the search paints, and a text adds and removes its own ranges only through `paint`.
const highlights = { match: new Highlight(), current: new Highlight() };
CSS.highlights.set("match", highlights.match);
CSS.highlights.set("match-current", highlights.current);

// Paints the matches `ranges` in the text node `node`, whose first character is at `from` in its text, the one starting
// at `current` as the current match. Gives what removes them.
export function paint(node: Text, from: number, ranges: Characters[], current: number | undefined): () => void {
  const painted = ranges.map(({ start, end }) => {
    const range = new Range();
    range.setStart(node, start - from);
    range.setEnd(node, end - from);
    const highlight = start === current ? highlights.current : highlights.match;
    highlight.add(range);
    return { highlight, range };
  });
  return () => {
    for (const { highlight, range } of painted) highlight.delete(range);
  };
}

// The current match as painted: undefined while no text shown holds it. `paint` adds only Ranges.
export function currentMatch(): Range | undefined {
  return highlights.current.values().next().value as Range | undefined;
}
