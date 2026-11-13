import { describe, expect, it } from "vitest";
import type { Placed } from "./position.ts";
import { step, type Rows } from "./scroll.ts";

// Three rows of 100, 50 and 300 pixels, in a view whose largest offset is 250 unless a case changes it.
const placed: Placed[] = [
  { key: "a", start: 0, size: 100 },
  { key: "b", start: 100, size: 50 },
  { key: "c", start: 150, size: 300 },
];
const rows: Rows = {
  indexOf: (key) => {
    const index = placed.findIndex((row) => row.key === key);
    return index === -1 ? undefined : index;
  },
  placed: (index) => placed[index],
  rowAt: (offset) => placed.findLast((row) => row.start <= offset),
};
const end = { at: "end" } as const;
const inC = { at: "row", key: "c", offset: 20 } as const;

describe("step", () => {
  it("writes the new end while following, as the content grows", () => {
    expect(step("change", 200, 250, { position: end, written: 200 }, true, rows)).toEqual({ position: end, written: 200, write: 250 });
  });

  it("keeps the position through a clamp: the browser moving the offset up to a nearer end", () => {
    expect(step("scroll", 150, 150, { position: end, written: 250 }, true, rows)).toEqual({ position: end, written: 150, write: undefined });
    // A place the clamp put out of reach is still the place, written past the end for the browser to clamp.
    expect(step("change", 150, 150, { position: inC, written: 240 }, true, rows)).toEqual({ position: inC, written: 150, write: 170 });
  });

  it("leaves a reader's offset to the scroll event, so a render never takes a clamp still to come for a scroll", () => {
    expect(step("change", 120, 250, { position: end, written: 250 }, true, rows)).toEqual({ position: end, written: 250, write: undefined });
  });

  it("takes a reader's scroll for the position: away from the end pauses, back to it resumes", () => {
    expect(step("scroll", 170, 250, { position: end, written: 250 }, true, rows)).toEqual({ position: inC, written: 170, write: undefined });
    expect(step("scroll", 250, 250, { position: inC, written: 170 }, true, rows)).toEqual({ position: end, written: 250, write: undefined });
  });

  it("keeps a gesture the browser stopped short of an end that grew while it ran as a place", () => {
    expect(step("scroll", 250, 400, { position: inC, written: 170 }, true, rows)).toEqual({
      position: { at: "row", key: "c", offset: 100 },
      written: 250,
      write: undefined,
    });
  });

  it("with follow off, takes the end as a place: a scroll to it, and the end the view was following, where it stands", () => {
    const atEnd = { at: "row", key: "c", offset: 100 };
    expect(step("scroll", 250, 250, { position: inC, written: 170 }, false, rows)).toEqual({ position: atEnd, written: 250, write: undefined });
    expect(step("change", 250, 250, { position: end, written: 250 }, false, rows)).toEqual({ position: atEnd, written: 250, write: undefined });
    // Before any row has arrived, the end is the start.
    expect(step("change", 0, 0, { position: end, written: 0 }, false, rows)).toEqual({ position: { at: "start" }, written: 0, write: undefined });
  });

  it("writes nothing for a position whose row has not arrived, as after a reload", () => {
    const later = { at: "row", key: "d", offset: 5 } as const;
    expect(step("change", 0, 250, { position: later, written: 0 }, true, rows)).toEqual({ position: later, written: 0, write: undefined });
  });
});
