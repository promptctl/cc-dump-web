import { describe, expect, it } from "vitest";
import { forkAbove, siblingFrom } from "./forks.ts";
import type { At } from "./position.ts";
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
// The fork above the place `at`, among `listed`.
const above = (at: At, listed: readonly Row[] = rows) => forkAbove(listed, at)?.key;
// A place at the row at `index`, `offset` into it.
const row = (index: number, offset = 0): At => ({ at: "row", index, offset });

describe("the fork above the reader's place", () => {
  it("is the last whose line is listed at or before the row the place is at", () => {
    expect([above(row(2)), above(row(3, 40)), above(row(5))]).toEqual(["b/fork", "b/fork", "e/fork"]);
  });

  it("is the fork whose line the place is at", () => {
    expect([above(row(1)), above(row(4, 4))]).toEqual(["b/fork", "e/fork"]);
  });

  it("is the first listed where none is above: at the start, and in a row before them all", () => {
    expect([above({ at: "start" }), above(row(0))]).toEqual(["b/fork", "b/fork"]);
  });

  it("is the last listed at the end, following", () => {
    expect(above({ at: "end" })).toBe("e/fork");
  });

  it("counts a place at the end of a row standing in for its own from that row", () => {
    expect(above(row(3, Infinity))).toBe("b/fork");
  });

  it("is none where the column lists no fork", () => {
    expect(above(row(0), [line("a"), line("c")])).toBeUndefined();
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
