import { describe, expect, it } from "vitest";
import { forkAbove, siblingFrom } from "./forks.ts";
import type { Position } from "./position.ts";
import type { ForkRow, Row } from "./rows.ts";

const standing = { depth: 0, dimmed: false };
const line = (key: string): Row => ({ kind: "group", key, title: "tools", change: "same", ...standing });
// A fork's line at `key`, of the siblings that begin at `steps`, the column showing `shown`.
const fork = (key: string, steps: number[] = [2, 5], shown: number | undefined = steps[0]): ForkRow => ({
  kind: "fork",
  key,
  change: "same",
  siblings: steps.map((step) => ({ step, preview: "" })),
  shown,
  ...standing,
});
// A line, a fork, two lines, a fork, a line.
const rows = [line("a"), fork("b/fork"), line("c"), line("d"), fork("e/fork"), line("f")];
const indexOf = (listed: readonly Row[]) => (key: string) => {
  const index = listed.findIndex((row) => row.key === key);
  return index === -1 ? undefined : index;
};
const above = (top: Exclude<Position, { at: "end" }>, listed: readonly Row[] = rows) => {
  const fork = forkAbove(listed, indexOf(listed), top);
  return fork === undefined || "unread" in fork ? fork : fork.key;
};
const at = (key: string, offset = 0): Position & { at: "row" } => ({ at: "row", key, offset });

describe("the fork above the view", () => {
  it("is the last whose line is listed at or before the row at the view's top", () => {
    expect([above(at("c")), above(at("d", 40)), above(at("f"))]).toEqual(["b/fork", "b/fork", "e/fork"]);
  });

  it("is the fork whose line is at the view's top", () => {
    expect([above(at("b/fork")), above(at("e/fork", 4))]).toEqual(["b/fork", "e/fork"]);
  });

  it("is the first listed where none is above: at the start, and in a row before them all", () => {
    expect([above({ at: "start" }), above(at("a"))]).toEqual(["b/fork", "b/fork"]);
  });

  it("is not taken from the start in place of a top whose row has not arrived, as after a reload", () => {
    expect([above(at("z")), above(at("z/body", 40))]).toEqual([{ unread: "z" }, { unread: "z/body" }]);
  });

  it("counts a top in a row not listed from the row listed before it", () => {
    // `d/hidden` is not listed: `d` stands for it.
    expect(above(at("d/hidden"))).toBe("b/fork");
  });

  it("is none where the column lists no fork", () => {
    expect(above(at("a"), [line("a"), line("c")])).toBeUndefined();
  });
});

describe("the sibling a switch goes to", () => {
  const three = fork("b/fork", [2, 5, 9], 5);

  it("is the one listed after the one the column shows, or before it", () => {
    expect([siblingFrom(three, undefined, "next"), siblingFrom(three, undefined, "previous")]).toEqual([9, 2]);
  });

  it("goes around the ends", () => {
    expect([siblingFrom({ ...three, shown: 9 }, undefined, "next"), siblingFrom({ ...three, shown: 2 }, undefined, "previous")]).toEqual([2, 9]);
  });

  it("goes on from the sibling a move is already going to, and from the one shown where the move goes to no sibling of the fork", () => {
    expect([siblingFrom(three, 9, "next"), siblingFrom(three, 2, "previous"), siblingFrom(three, 7, "next")]).toEqual([2, 9, 9]);
  });

  it("goes to the first, or back to the last, before any of them arrived", () => {
    const none = { ...three, shown: undefined };
    expect([siblingFrom(none, undefined, "next"), siblingFrom(none, undefined, "previous")]).toEqual([2, 9]);
  });
});
