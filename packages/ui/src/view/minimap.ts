import { categories, type Category } from "../format/blocks.ts";
import { cssVariables, type Theme } from "../theme/theme.ts";
import { blockOf, categoryOf, changeColors, markOf, type Change, type Row } from "./rows.ts";

// The minimap (docs/design/02-design.md, "Layout"): the conversation's rows drawn top to bottom at the minimap's height,
// the vertical navigator. Its geometry, pure: what each row is drawn as and where, and the way back from a point on it to
// a place in the conversation.

// [LAW:types-are-the-program] What a row's sliver is painted: a block in its category's color, or the theme's error for a
// tool's result that says its tool failed, and a fold that holds one; a set's line in its blocks' category's color,
// which it stands for while it is closed; an exchange's line and any other fold muted; a group's title not at all.
export type Paint = Category | "failed" | "exchange" | "fold" | "none";

// A row as the minimap draws it: from `y`, `height` minimap pixels tall, painted `paint`, beside its mark, `change`
// (rows.ts, markOf).
export type Sliver = { y: number; height: number; paint: Paint; change: Change };

// Where a row is in the conversation, in its pixels: its start and its height, measured or estimated.
export type Extent = { start: number; size: number };

export function paintOf(row: Row): Paint {
  switch (row.kind) {
    case "block": {
      const { failed, category } = blockOf(row);
      return failed ? "failed" : category;
    }
    case "exchange":
      return "exchange";
    case "fold":
      return row.rows.some((held) => paintOf(held) === "failed") ? "failed" : "fold";
    case "set":
      return categoryOf(row);
    case "group":
      return "none";
  }
}

// The minimap's pixels per pixel of the conversation: the whole conversation in the minimap's height, or, shorter than
// it, at its own size, so a short one is not stretched.
export function scaleOf(total: number, height: number): number {
  return height / Math.max(total, height);
}

// Each row's sliver, at least a pixel tall so a short row in a long conversation is still seen, in the order they are
// drawn: the failed last, so the rows sharing their pixels never paint over them. `extents`: each row's, in the order of
// `rows`.
export function slivers(rows: readonly Row[], extents: readonly Extent[], scale: number): Sliver[] {
  return rows
    .map((row, index): Sliver => {
      const { start, size } = extents[index]!;
      return { y: start * scale, height: Math.max(1, size * scale), paint: paintOf(row), change: markOf(row) };
    })
    .sort((a, b) => Number(a.paint === "failed") - Number(b.paint === "failed"));
}

// The view's box on the minimap: the scroller's offset and height, scaled.
export function viewBox(offset: number, viewport: number, scale: number): { y: number; height: number } {
  return { y: offset * scale, height: viewport * scale };
}

// [LAW:one-source-of-truth] The minimap's colors, the theme's variables the rows are painted in: each category its
// gutter's, a failed tool's result the error, the exchange's line and a fold muted, as the rows' text is; what a step
// did as the band at a row's edge is (changeColors); the view's box in the foreground. Read from the theme, not the
// document, as the terminal's canvas reads it.
export function colorsOf(theme: Theme): { paint: Record<Paint, string>; change: Record<Change, string>; view: string } {
  const vars = cssVariables(theme);
  const variable = (name: `--${string}`) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`The theme ${theme.name} has no ${name}`);
    return value;
  };
  return {
    paint: {
      ...(Object.fromEntries(categories.map((category) => [category, variable(`--category-${category}`)])) as Record<Category, string>),
      failed: variable("--error"),
      exchange: variable("--foreground-muted"),
      fold: variable("--foreground-disabled"),
      none: "transparent",
    },
    change: Object.fromEntries(Object.entries(changeColors).map(([change, name]) => [change, name === undefined ? "transparent" : variable(name)])) as Record<Change, string>,
    view: variable("--foreground"),
  };
}

// The offset a point `y` on the minimap puts the view at: the place under the point at the view's middle, within the
// offsets the conversation has.
export function offsetAt(y: number, scale: number, viewport: number, total: number): number {
  return Math.min(Math.max(0, y / scale - viewport / 2), Math.max(0, total - viewport));
}
