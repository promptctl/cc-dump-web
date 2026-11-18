import { describe, expect, it } from "vitest";
import type { Block } from "../format/blocks.ts";
import type { FormattedExchange, KeyedBlock } from "../format/format.ts";
import { themeNames, themeOf } from "../theme/theme.ts";
import { colorsOf, notchAt, offsetAt, paintOf, scaleOf, slivers, viewBox } from "./minimap.ts";
import type { Change, ForkRow, Row, SetRow } from "./rows.ts";

const block = (fields: Partial<Block> = {}): KeyedBlock => ({ key: "content.0", category: "tools", name: "tool_result", parts: [], ...fields });
const standing = { depth: 0, dimmed: false };
const exchange: Row = { kind: "exchange", key: "t1", exchange: {} as FormattedExchange, change: "added", ...standing };
const group: Row = { kind: "group", key: "t1/tools", title: "tools", change: "same", ...standing };
const brought = (shown: KeyedBlock) => ({ step: 1, block: shown, reply: false, rewrote: undefined, previous: undefined });
// A set of one block, which step 1 brought and step 2 took away, at the step after.
const set: SetRow = { kind: "set", key: "t1/tools", title: "tools", change: "same", items: [{ key: "t1/c", versions: [brought(block()), { step: 2, block: undefined, was: block(), previous: 0 }] }], step: 3, steps: new Set([1, 2, 3]), ...standing };
const fork = (key: string, depth = 0): ForkRow => ({ kind: "fork", key, change: "same", siblings: [], shown: undefined, depth, dimmed: false });
const nest = (depth: number): Row => ({ kind: "nest", key: "t1/b/nest", change: "same", type: undefined, prompt: "", count: 1, latest: undefined, depth, dimmed: false });
const thread: Row = { kind: "thread", key: "t1/b/thread", change: "same", ...standing };
const added = (shown: KeyedBlock, depth = 0): Row => ({ kind: "block", key: "t1/b", change: "added", versions: [brought(shown)], at: 0, set: undefined, depth, dimmed: false });
// A block step 1 brought and step 2 took away, at step 2 or, left as it was, a step after.
const removed = (was: KeyedBlock, change: Change = "removed"): Row => ({ kind: "block", key: "t1/c", change, versions: [brought(was), { step: 2, block: undefined, was, previous: 0 }], at: 1, set: undefined, ...standing });

describe("paintOf", () => {
  it("paints a block its category, a failed tool's result the error, a removed block as it was", () => {
    expect([paintOf(added(block({ category: "user" }))), paintOf(added(block({ failed: true }))), paintOf(removed(block({ category: "thinking" })))]).toEqual(["user", "failed", "thinking"]);
  });

  it("paints the line of an exchange, a fork, a nest and a thread muted, a set's line its blocks' category, and a group's title not at all", () => {
    expect([exchange, fork("t1/fork"), nest(0), thread, set, group].map(paintOf)).toEqual(["line", "line", "line", "line", "tools", "none"]);
  });
});

describe("scaleOf", () => {
  it("fits the whole conversation in the minimap's height, and draws a shorter one at its own size", () => {
    expect([scaleOf(10_000, 500), scaleOf(200, 500)]).toEqual([0.05, 1]);
  });
});

describe("slivers", () => {
  it("places each row by its extent, scaled, at least a pixel tall, beside what the step did to it", () => {
    const rows = [exchange, added(block()), nest(0)];
    const extents = [
      { start: 0, size: 40 },
      { start: 40, size: 10 },
      { start: 50, size: 950 },
    ];
    expect(slivers(rows, extents, 0.05)).toEqual([
      { y: 0, height: 2, paint: "line", change: "added", bars: 0, fork: undefined },
      { y: 2, height: 1, paint: "tools", change: "added", bars: 0, fork: undefined },
      { y: 2.5, height: 47.5, paint: "line", change: "same", bars: 0, fork: undefined },
    ]);
  });

  it("says how far in a row stands, as a bar for each level up to two, and the fork a fork's line is of", () => {
    const rows = [nest(0), added(block(), 1), nest(1), added(block(), 2), fork("t9/fork", 2), added(block(), 3)];
    const extents = rows.map((_, index) => ({ start: index * 20, size: 20 }));
    expect(slivers(rows, extents, 1).map(({ bars, fork }) => [bars, fork?.key])).toEqual([
      [0, undefined],
      [1, undefined],
      [1, undefined],
      [2, undefined],
      [2, "t9/fork"],
      [2, undefined],
    ]);
  });

  it("marks a row a step left as it was by the last thing a step did to it", () => {
    const rows = [removed(block()), removed(block(), "same"), group, set];
    const extents = [0, 40, 80, 120].map((start) => ({ start, size: 40 }));
    expect(slivers(rows, extents, 1).map(({ change }) => change)).toEqual(["removed", "removed", "same", "removed"]);
  });

  it("draws a failed row over the rows that share its pixels", () => {
    const rows = [added(block({ failed: true })), added(block()), added(block())];
    const extents = [0, 40, 80].map((start) => ({ start, size: 40 }));
    expect(slivers(rows, extents, 0.01).map(({ y, paint }) => [y, paint])).toEqual([
      [0.4, "tools"],
      [0.8, "tools"],
      [0, "failed"],
    ]);
  });
});

describe("notchAt", () => {
  // Two forks' lines, one after the other, each drawn 5 pixels tall: their middles at 102.5 and 107.5.
  const rows = Array.from({ length: 60 }, (_, index) => (index === 20 ? fork("a/fork") : index === 21 ? fork("b/fork") : added(block())));
  const drawn = slivers(rows, rows.map((_, index) => ({ start: index * 100, size: 100 })), 0.05);

  it("is the fork whose notch a point of the gutter is on, the nearer of two", () => {
    const at = (x: number, y: number) => notchAt(drawn, x, y)?.key;
    expect([at(4, 102), at(0, 98), at(4, 104), at(4, 106), at(7, 112)]).toEqual(["a/fork", "a/fork", "a/fork", "b/fork", "b/fork"]);
  });

  it("is none away from every notch, and none beside the gutter, where a press places the view", () => {
    expect([notchAt(drawn, 4, 90), notchAt(drawn, 4, 120), notchAt(drawn, 8, 105), notchAt(drawn, 30, 105)]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("colorsOf", () => {
  it("has a color for every paint and every change in every theme", () => {
    for (const name of themeNames) {
      const { paint, change, view, gutter } = colorsOf(themeOf(name));
      expect([...Object.values(paint), ...Object.values(change), view, gutter].every((color) => /^#[0-9a-f]{6}$|^transparent$/i.test(color)), name).toBe(true);
    }
  });
});

describe("the way back from the minimap", () => {
  it("puts the view's middle at the place under the point, within the conversation's offsets", () => {
    // A conversation of 10,000 pixels in a minimap of 500, the view 1,000 tall.
    const at = (y: number) => offsetAt(y, scaleOf(10_000, 500), 1000, 10_000);
    expect([at(250), at(0), at(500)]).toEqual([4500, 0, 9000]);
  });

  it("puts the view at the start of a conversation shorter than it", () => {
    expect(offsetAt(150, scaleOf(300, 500), 1000, 300)).toBe(0);
  });

  it("draws the view's box where a point in it puts the view back", () => {
    const scale = scaleOf(10_000, 500);
    const box = viewBox(4500, 1000, scale);
    expect([box, offsetAt(box.y + box.height / 2, scale, 1000, 10_000)]).toEqual([{ y: 225, height: 50 }, 4500]);
  });
});
