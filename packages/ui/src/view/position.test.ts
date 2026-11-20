import { describe, expect, it } from "vitest";
import { positionAt, resolve, rowIndex, type Placed } from "./position.ts";

// Three rows of 100, 50 and 300 pixels.
const rows: Placed[] = [
  { key: "a", start: 0, size: 100 },
  { key: "b", start: 100, size: 50 },
  { key: "c", start: 150, size: 300 },
];
const indexOf = (key: string) => {
  const index = rows.findIndex((row) => row.key === key);
  return index === -1 ? undefined : index;
};
const placed = (index: number) => rows[index];
const rowAt = (offset: number) => rows.findLast((row) => row.start <= offset);

describe("position", () => {
  it("resolves the end past every offset, the start to 0, and a row to its start plus the offset into it", () => {
    expect(resolve({ at: "end" }, indexOf, placed)).toBe(Infinity);
    expect(resolve({ at: "start" }, indexOf, placed)).toBe(0);
    expect(resolve({ at: "row", key: "c", offset: 20 }, indexOf, placed)).toBe(170);
  });

  it("does not resolve a row that is not among the rows, as one not read yet after a reload", () => {
    expect(resolve({ at: "row", key: "d", offset: 20 }, indexOf, placed)).toBeUndefined();
  });

  it("resolves a row that is gone from among the rows to the end of the nearest row it was inside", () => {
    expect(resolve({ at: "row", key: "c/body", offset: 20 }, indexOf, placed)).toBe(450);
    expect(resolve({ at: "row", key: "c/gone/body", offset: 400 }, indexOf, placed)).toBe(450);
    expect(resolve({ at: "row", key: "d/body", offset: 20 }, indexOf, placed)).toBeUndefined();
  });

  it("puts the view at the end of a row shorter than the offset into it", () => {
    expect(resolve({ at: "row", key: "b", offset: 400 }, indexOf, placed)).toBe(150);
  });

  it("puts the view at the end of the row standing in for a hidden one, where the hidden one stood, whatever the offset into it", () => {
    const hidden = (key: string) => (key === "b/hidden" ? 0 : indexOf(key));
    expect(resolve({ at: "row", key: "b/hidden", offset: 30 }, hidden, placed)).toBe(100);
  });

  it("finds the nearest row a key is inside, each prefix ending before a slash, the empty key's row included, and ends on every key", () => {
    // A key has one prefix to probe per segment; a probe past them throws, rather than letting a loop that never ends hang the run.
    const inside = (key: string, keys: string[]) => {
      let probes = key.split("/").length;
      return rowIndex(key, (prefix) => {
        if (probes-- === 0) throw new Error(`rowIndex probed past the prefixes of ${JSON.stringify(key)}, at ${JSON.stringify(prefix)}`);
        const index = keys.indexOf(prefix);
        return index === -1 ? undefined : index;
      });
    };
    expect(inside("/request/http", ["", "x"])).toBe(0);
    expect(inside("//", ["", "x"])).toBe(0);
    expect(inside("/request/http", ["x"])).toBeUndefined();
    expect(inside("//", ["x"])).toBeUndefined();
    expect(inside("a/b/c", ["x", "a"])).toBe(1);
    expect(inside("a/b", [""])).toBeUndefined();
    expect(inside("x", [""])).toBeUndefined();
  });

  it("reads the position back from an offset: the row at the top and how far into it, or the start", () => {
    expect(positionAt(170, rowAt)).toEqual({ at: "row", key: "c", offset: 20 });
    expect(positionAt(0, rowAt)).toEqual({ at: "start" });
    expect(resolve(positionAt(123, rowAt), indexOf, placed)).toBe(123);
  });
});
