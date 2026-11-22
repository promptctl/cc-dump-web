import { describe, expect, it } from "vitest";
import { positionAt, resolve, rowIndex, startOf, type Placed } from "./position.ts";

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

  // The row rowIndex finds for `key` among rows keyed `keys`. No key has more than length + 1 prefixes; a probe past
  // that many throws, so a walk that never ends fails the run rather than hanging it.
  const inside = (key: string, keys: string[]) => {
    let probes = key.length + 1;
    return rowIndex(key, (prefix) => {
      if (probes-- === 0) throw new Error(`rowIndex probed more keys than ${JSON.stringify(key)} has prefixes`);
      const index = keys.indexOf(prefix);
      return index === -1 ? undefined : index;
    });
  };

  it("finds the nearest row a key is inside, the longest of its prefixes cut at a slash", () => {
    expect(inside("a/b/c", ["a", "a/b"])).toBe(1);
    expect(inside("a/b/c", ["x", "a"])).toBe(1);
    expect(inside("ab/c", ["a"])).toBeUndefined();
    expect(inside("a/b/c", ["a/"])).toBeUndefined();
  });

  it("ends on every key, one starting with a slash among them", () => {
    expect(inside("//", ["x"])).toBeUndefined();
    expect(inside("/request/http", ["x"])).toBeUndefined();
    expect(inside("", ["x"])).toBeUndefined();
  });

  it("starts a move from the reader's place while the rows hold it, waits while the read has still to bring it, and is from the view otherwise", () => {
    const toBeRead = (key: string) => key.startsWith("d");
    const at = (key: string) => ({ at: "row", key, offset: 20 }) as const;
    expect([startOf({ at: "start" }, indexOf, toBeRead), startOf({ at: "end" }, indexOf, toBeRead)]).toEqual([{ at: "start" }, { at: "end" }]);
    // Its row, or the row it is inside, as a block the formatter replaced is.
    expect([startOf(at("c"), indexOf, toBeRead), startOf(at("c/body"), indexOf, toBeRead)]).toEqual([at("c"), at("c/body")]);
    expect(startOf(at("d/body"), indexOf, toBeRead)).toEqual({ at: "waiting", on: "place" });
    // A row that will not arrive: the read ended without it, or it is another history's.
    expect(startOf(at("e"), indexOf, toBeRead)).toEqual({ at: "view" });
  });

  it("reads the position back from an offset: the row at the top and how far into it, or the start", () => {
    expect(positionAt(170, rowAt)).toEqual({ at: "row", key: "c", offset: 20 });
    expect(positionAt(0, rowAt)).toEqual({ at: "start" });
    expect(resolve(positionAt(123, rowAt), indexOf, placed)).toBe(123);
  });
});
