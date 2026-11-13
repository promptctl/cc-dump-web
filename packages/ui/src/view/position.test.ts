import { describe, expect, it } from "vitest";
import { positionAt, resolve, type Placed } from "./position.ts";

// Three rows of 100, 50 and 300 pixels, in a view whose largest offset is 250.
const rows: Placed[] = [
  { key: "a", start: 0, size: 100 },
  { key: "b", start: 100, size: 50 },
  { key: "c", start: 150, size: 300 },
];
const end = 250;
const indexOf = (key: string) => {
  const index = rows.findIndex((row) => row.key === key);
  return index === -1 ? undefined : index;
};
const placed = (index: number) => rows[index];
const rowAt = (offset: number) => rows.findLast((row) => row.start <= offset);

describe("position", () => {
  it("resolves the end to the largest offset, the start to 0, and a row to its start plus the offset into it", () => {
    expect(resolve({ at: "end" }, end, indexOf, placed)).toBe(250);
    expect(resolve({ at: "start" }, end, indexOf, placed)).toBe(0);
    expect(resolve({ at: "row", key: "c", offset: 20 }, end, indexOf, placed)).toBe(170);
  });

  it("does not resolve a row that is not among the rows, as one not read yet after a reload", () => {
    expect(resolve({ at: "row", key: "d", offset: 20 }, end, indexOf, placed)).toBeUndefined();
  });

  it("resolves a row that is gone from among the rows to the nearest row it was inside", () => {
    expect(resolve({ at: "row", key: "c/body", offset: 20 }, end, indexOf, placed)).toBe(170);
    expect(resolve({ at: "row", key: "c/gone/body", offset: 400 }, end, indexOf, placed)).toBe(450);
    expect(resolve({ at: "row", key: "d/body", offset: 20 }, end, indexOf, placed)).toBeUndefined();
  });

  it("puts the view at the end of a row shorter than the offset into it", () => {
    expect(resolve({ at: "row", key: "b", offset: 400 }, end, indexOf, placed)).toBe(150);
  });

  it("reads the position back from an offset: the row at the top and how far into it, or the start", () => {
    expect(positionAt(170, rowAt)).toEqual({ at: "row", key: "c", offset: 20 });
    expect(positionAt(0, rowAt)).toEqual({ at: "start" });
    expect(resolve(positionAt(123, rowAt), end, indexOf, placed)).toBe(123);
  });
});
