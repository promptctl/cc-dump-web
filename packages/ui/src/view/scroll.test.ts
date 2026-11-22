import { describe, expect, it } from "vitest";
import { presence, type Placed } from "./position.ts";
import { step, type Rows } from "./scroll.ts";

// Three rows of 100, 50 and 300 pixels, in a view whose largest offset is 250 unless a case changes it.
const placed: Placed[] = [
  { key: "a", start: 0, size: 100 },
  { key: "b", start: 100, size: 50 },
  { key: "c", start: 150, size: 300 },
];
const indexOf = (key: string) => {
  const index = placed.findIndex((row) => row.key === key);
  return index === -1 ? undefined : index;
};
// The rows, every one listed; a row `d` the read can still bring, and any other not among them that nothing will.
const rows: Rows = {
  judge: (position) => presence(position, { at: (index) => placed[index]!.key, indexOf }, indexOf, (key) => key.startsWith("d")),
  placed: (index) => placed[index],
  rowAt: (offset) => placed.findLast((row) => row.start <= offset),
};
const end = { at: "end" } as const;
const inC = { at: "row", key: "c", offset: 20 } as const;

describe("step", () => {
  it("writes the new end while following, as the content grows", () => {
    expect(step("change", 200, 250, { position: end, written: 200 }, true, true, rows)).toEqual({ position: end, written: 200, write: 250, by: "view" });
  });

  it("keeps the position through a clamp: the browser moving the offset up to a nearer end", () => {
    expect(step("scroll", 150, 150, { position: end, written: 250 }, true, true, rows)).toEqual({ position: end, written: 150, write: undefined, by: "view" });
    // A place the clamp put out of reach is still the place, and the view stays at the end, as near it as it can be.
    expect(step("change", 150, 150, { position: inC, written: 240 }, true, true, rows)).toEqual({ position: inC, written: 150, write: undefined, by: "view" });
  });

  it("leaves a reader's offset to the scroll event, so a render never takes a clamp still to come for a scroll", () => {
    expect(step("change", 120, 250, { position: end, written: 250 }, true, true, rows)).toEqual({ position: end, written: 250, write: undefined, by: "reader" });
  });

  it("takes a reader's scroll for the position: away from the end pauses, back to it resumes", () => {
    expect(step("scroll", 170, 250, { position: end, written: 250 }, true, true, rows)).toEqual({ position: inC, written: 170, write: undefined, by: "reader" });
    expect(step("scroll", 250, 250, { position: inC, written: 170 }, true, true, rows)).toEqual({ position: end, written: 250, write: undefined, by: "reader" });
  });

  it("takes an offset within a pixel of the end for the end while following, and a pixel short of it for a place", () => {
    expect(step("scroll", 249.5, 250, { position: inC, written: 170 }, true, true, rows).position).toEqual(end);
    expect(step("scroll", 249, 250, { position: inC, written: 170 }, true, true, rows).position).toEqual({ at: "row", key: "c", offset: 99 });
  });

  it("holds a position chosen with the control over a reader's scroll still under way", () => {
    // Paused, the reader clicks to follow while their scroll's event is still to come: the view goes to the end.
    expect(step("choose", 120, 250, { position: end, written: 170 }, true, true, rows)).toEqual({ position: end, written: 120, write: 250, by: "view" });
    // Following, the reader clicks to stop: the view stays where the scroll has taken it.
    expect(step("choose", 120, 250, { position: end, written: 250 }, false, true, rows)).toEqual({
      position: { at: "row", key: "b", offset: 20 },
      written: 120,
      write: undefined,
      by: "view",
    });
  });

  it("keeps a gesture the browser stopped short of an end that grew while it ran as a place", () => {
    expect(step("scroll", 250, 400, { position: inC, written: 170 }, true, true, rows)).toEqual({
      position: { at: "row", key: "c", offset: 100 },
      written: 250,
      write: undefined,
      by: "reader",
    });
  });

  it("with follow off, takes the end as a place: a scroll to it, and the end the view was following, where it stands", () => {
    const atEnd = { at: "row", key: "c", offset: 100 };
    expect(step("scroll", 250, 250, { position: inC, written: 170 }, false, true, rows)).toEqual({ position: atEnd, written: 250, write: undefined, by: "reader" });
    expect(step("change", 250, 250, { position: end, written: 250 }, false, true, rows)).toEqual({ position: atEnd, written: 250, write: undefined, by: "view" });
    // Before any row has arrived, the end is the start.
    expect(step("change", 0, 0, { position: end, written: 0 }, false, true, rows)).toEqual({ position: { at: "start" }, written: 0, write: undefined, by: "view" });
  });

  it("takes the end of a step chosen in time for a place, with follow on: only a moment that resumes follows there", () => {
    expect(step("scroll", 250, 250, { position: inC, written: 170 }, true, false, rows)).toEqual({ position: { at: "row", key: "c", offset: 100 }, written: 250, write: undefined, by: "reader" });
  });

  it("keeps a place the read can still bring, as after a reload, and writes nothing until it arrives", () => {
    const later = { at: "row", key: "d", offset: 5 } as const;
    expect(step("change", 0, 250, { position: later, written: 0 }, true, true, rows)).toEqual({ position: later, written: 0, write: undefined, by: "view" });
    // Under a reader's offset whose scroll event is still to come, too.
    expect(step("change", 120, 250, { position: later, written: 0 }, true, true, rows)).toEqual({ position: later, written: 0, write: undefined, by: "reader" });
  });

  it("takes a reader's scroll off a place not read yet for the reader's place, by the reader", () => {
    const later = { at: "row", key: "d", offset: 5 } as const;
    expect(step("scroll", 170, 250, { position: later, written: 0 }, true, true, rows)).toEqual({ position: inC, written: 170, write: undefined, by: "reader" });
  });

  it("replaces a place nothing will bring with the place under the view, as the view's own, on a render and on a scroll", () => {
    const gone = { at: "row", key: "z", offset: 5 } as const;
    expect(step("change", 170, 250, { position: gone, written: 170 }, true, true, rows)).toEqual({ position: inC, written: 170, write: undefined, by: "view" });
    expect(step("scroll", 170, 250, { position: gone, written: 170 }, true, true, rows)).toEqual({ position: inC, written: 170, write: undefined, by: "view" });
    // Under a reader's offset, the offset is still the scroll event's to take.
    expect(step("change", 170, 250, { position: gone, written: 0 }, true, true, rows)).toEqual({ position: inC, written: 0, write: undefined, by: "view" });
  });
});
