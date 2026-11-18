import { categories, type Category } from "../format/blocks.ts";
import { cssVariables, type Theme } from "../theme/theme.ts";
import { blockOf, categoryOf, changeColors, markOf, type Change, type ForkRow, type Row } from "./rows.ts";

// The minimap (docs/design/02-design.md, "Layout"): the conversation's rows drawn top to bottom at the minimap's height,
// the vertical navigator. Its geometry, pure: what each row is drawn as and where, and the way back from a point on it to
// a place in the conversation.

// [LAW:types-are-the-program] What a row's sliver is painted: a block in its category's color, or the theme's error for a
// tool's result that says its tool failed; a set's line in its blocks' category's color, which it stands for while it
// is closed; the line of an exchange, a fork, a nest or a thread muted; a group's title not at all.
export type Paint = Category | "failed" | "line" | "none";

// A row as the minimap draws it: from `y`, `height` minimap pixels tall, painted `paint`, beside its mark, `change`
// (rows.ts, markOf). In the gutter at its left, the structure: `bars`, one for each Agent call the row is under, up to
// two, so a nest is a bar along its span and a nest in a nest a second; and, for a fork's line, the notch of the
// `fork` it is.
export type Sliver = { y: number; height: number; paint: Paint; change: Change; bars: number; fork: ForkRow | undefined };

// The gutter, in minimap pixels: how wide it is, how wide a bar is and how far apart two start, and a notch's reach,
// how far from its middle a point is still on it.
export const gutter = { width: 8, bar: 2, pitch: 3, notch: 3, reach: 5 } as const;

// Where a row is in the conversation, in its pixels: its start and its height, measured or estimated.
export type Extent = { start: number; size: number };

export function paintOf(row: Row): Paint {
  switch (row.kind) {
    case "block": {
      const { failed, category } = blockOf(row);
      return failed ? "failed" : category;
    }
    case "exchange":
    case "fork":
    case "nest":
    case "thread":
      return "line";
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
      return { y: start * scale, height: Math.max(1, size * scale), paint: paintOf(row), change: markOf(row), bars: Math.min(row.depth, 2), fork: row.kind === "fork" ? row : undefined };
    })
    .sort((a, b) => Number(a.paint === "failed") - Number(b.paint === "failed"));
}

// The fork whose notch the point `x`, `y` of the minimap is on: the nearest whose line's middle is within a notch's
// reach of a point in the gutter. None anywhere else, where a press places the view.
export function notchAt(drawn: readonly Sliver[], x: number, y: number): ForkRow | undefined {
  if (x < 0 || x >= gutter.width) return undefined;
  const away = (sliver: Sliver) => Math.abs(sliver.y + sliver.height / 2 - y);
  const nearest = drawn.reduce<Sliver | undefined>((nearest, sliver) => (sliver.fork !== undefined && away(sliver) <= gutter.reach && (nearest === undefined || away(sliver) < away(nearest)) ? sliver : nearest), undefined);
  return nearest?.fork;
}

// The view's box on the minimap: the scroller's offset and height, scaled.
export function viewBox(offset: number, viewport: number, scale: number): { y: number; height: number } {
  return { y: offset * scale, height: viewport * scale };
}

// [LAW:one-source-of-truth] The minimap's colors, the theme's variables the rows are painted in: each category its
// gutter's, a failed tool's result the error, a line muted, as the rows' text is; what a step did as the band at a
// row's edge is (changeColors); the view's box in the foreground; and the structure in its gutter muted, never a
// category's color or a change's. Read from the theme, not the document, as the terminal's canvas reads it.
export function colorsOf(theme: Theme): { paint: Record<Paint, string>; change: Record<Change, string>; view: string; gutter: string } {
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
      line: variable("--foreground-muted"),
      none: "transparent",
    },
    change: Object.fromEntries(Object.entries(changeColors).map(([change, name]) => [change, name === undefined ? "transparent" : variable(name)])) as Record<Change, string>,
    view: variable("--foreground"),
    gutter: variable("--foreground-muted"),
  };
}

// The offset a point `y` on the minimap puts the view at: the place under the point at the view's middle, within the
// offsets the conversation has.
export function offsetAt(y: number, scale: number, viewport: number, total: number): number {
  return Math.min(Math.max(0, y / scale - viewport / 2), Math.max(0, total - viewport));
}
