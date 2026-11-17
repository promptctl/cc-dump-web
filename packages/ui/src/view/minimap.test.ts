import { describe, expect, it } from "vitest";
import type { Block } from "../format/blocks.ts";
import type { FormattedExchange, KeyedBlock } from "../format/format.ts";
import { themeNames, themeOf } from "../theme/theme.ts";
import { colorsOf, offsetAt, paintOf, scaleOf, slivers, viewBox } from "./minimap.ts";
import type { Change, Row, SetRow } from "./rows.ts";

const block = (fields: Partial<Block> = {}): KeyedBlock => ({ key: "content.0", category: "tools", name: "tool_result", parts: [], ...fields });
const exchange: Row = { kind: "exchange", key: "t1", exchange: {} as FormattedExchange, change: "added", branch: undefined };
const group: Row = { kind: "group", key: "t1/tools", title: "tools", change: "same", branch: undefined };
// A set of one block, which step 1 brought and step 2 took away, at the step after.
const set: SetRow = { kind: "set", key: "t1/tools", title: "tools", change: "same", branch: undefined, items: [{ key: "t1/c", versions: [{ step: 1, block: block(), reply: false }, { step: 2, block: undefined, was: block() }] }], step: 3 };
const fold = (rows: Row[] = []): Row => ({ kind: "fold", key: "t1/a", rows, branch: { key: "branch:side", from: 2 } });
const added = (shown: KeyedBlock): Row => ({ kind: "block", key: "t1/b", change: "added", versions: [{ step: 1, block: shown, reply: false }], at: 0, branch: undefined, set: undefined });
// A block step 1 brought and step 2 took away, at step 2 or, left as it was, a step after.
const removed = (was: KeyedBlock, change: Change = "removed"): Row => ({ kind: "block", key: "t1/c", change, versions: [{ step: 1, block: was, reply: false }, { step: 2, block: undefined, was }], at: 1, branch: undefined, set: undefined });

describe("paintOf", () => {
  it("paints a block its category, a failed tool's result the error, a removed block as it was", () => {
    expect([paintOf(added(block({ category: "user" }))), paintOf(added(block({ failed: true }))), paintOf(removed(block({ category: "thinking" })))]).toEqual(["user", "failed", "thinking"]);
  });

  it("paints an exchange's line and a fold muted, a set's line its blocks' category, and a group's title not at all", () => {
    expect([exchange, fold([exchange, added(block())]), set, group].map(paintOf)).toEqual(["exchange", "fold", "tools", "none"]);
  });

  it("paints a fold that holds a failed tool's result the error, so a folded branch never hides a failure", () => {
    expect(paintOf(fold([exchange, added(block({ failed: true }))]))).toBe("failed");
  });
});

describe("scaleOf", () => {
  it("fits the whole conversation in the minimap's height, and draws a shorter one at its own size", () => {
    expect([scaleOf(10_000, 500), scaleOf(200, 500)]).toEqual([0.05, 1]);
  });
});

describe("slivers", () => {
  it("places each row by its extent, scaled, at least a pixel tall, beside what the step did to it", () => {
    const rows = [exchange, added(block()), fold()];
    const extents = [
      { start: 0, size: 40 },
      { start: 40, size: 10 },
      { start: 50, size: 950 },
    ];
    expect(slivers(rows, extents, 0.05)).toEqual([
      { y: 0, height: 2, paint: "exchange", change: "added" },
      { y: 2, height: 1, paint: "tools", change: "added" },
      { y: 2.5, height: 47.5, paint: "fold", change: "same" },
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

describe("colorsOf", () => {
  it("has a color for every paint and every change in every theme", () => {
    for (const name of themeNames) {
      const { paint, change, view } = colorsOf(themeOf(name));
      expect([...Object.values(paint), ...Object.values(change), view].every((color) => /^#[0-9a-f]{6}$|^transparent$/i.test(color)), name).toBe(true);
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
