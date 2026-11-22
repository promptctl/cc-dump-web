import { describe, expect, it } from "vitest";
import { afterAll, arrives, beforeAll, bottom, fromStart, positionAt, resolve, rowIndex, startAt, top, waitingLine, type Placed, type Slot, type Start } from "./position.ts";

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

  it("reads the position back from an offset: the row at the top and how far into it, or the start", () => {
    expect(positionAt(170, rowAt)).toEqual({ at: "row", key: "c", offset: 20 });
    expect(positionAt(0, rowAt)).toEqual({ at: "start" });
    expect(resolve(positionAt(123, rowAt), indexOf, placed)).toBe(123);
  });
});

describe("where a move starts", () => {
  // `b/hidden` is a row a category hides, which the row listed before it, `b`, stands for (rows.ts, Keys).
  const keys = { at: (index: number) => rows[index]!.key, indexOf: (key: string) => (key === "b/hidden" ? 1 : indexOf(key)) };
  const slotOf = (start: Start) => (start.at === "slot" ? start.slot : undefined);
  const row = (key: string, offset = 0) => slotOf(startAt({ at: "row", key, offset }, keys))!;

  it("counts on one axis: the start, a row's top, some way into it, its bottom, just after it, the next row, the end", () => {
    const order = [slotOf(startAt({ at: "start" }, keys))!, row("b"), row("b", 40), bottom(1), row("b/hidden"), top(2), slotOf(startAt({ at: "end" }, keys))!];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    expect([order[0], order[1], order.at(-1)]).toEqual([beforeAll, top(1), afterAll]);
  });

  it("stands a replaced row just after the row it was inside, as a hidden one does after the row listed before it", () => {
    expect(row("c/body")).toBe(row("c/gone/body"));
    expect(row("c/body")).toBeGreaterThan(bottom(2));
    expect(row("b/hidden")).toBeLessThan(top(2));
  });

  it("waits while not even the outermost row a key is inside is among the rows", () => {
    expect([startAt({ at: "row", key: "d", offset: 0 }, keys), startAt({ at: "row", key: "d/body", offset: 5 }, keys)]).toEqual([{ at: "waiting" }, { at: "waiting" }]);
  });

  it("takes no move while it waits, and the move from its slot otherwise", () => {
    const moves: Slot[] = [];
    const move = (from: Slot) => moves.push(from);
    expect(fromStart({ at: "waiting" }, move)).toBeUndefined();
    expect(moves).toEqual([]);
    fromStart({ at: "slot", slot: top(1) }, move);
    expect(moves).toEqual([top(1)]);
  });
});

describe("a row's arrival", () => {
  it("is among the rows, or one the read can still bring", () => {
    expect([arrives("c/body", indexOf, () => false), arrives("d", indexOf, () => true), arrives("d", indexOf, () => false)]).toEqual([true, true, false]);
  });
});

describe("the line under the rows", () => {
  const slot = { at: "slot", slot: top(0) } as const;
  const waiting = { at: "waiting" } as const;

  it("says which start the moves wait on, the reader's place first, and nothing while none waits", () => {
    expect([waitingLine(slot, undefined), waitingLine(slot, slot), waitingLine(waiting, slot), waitingLine(slot, waiting), waitingLine(waiting, waiting)]).toEqual([
      "",
      "",
      "Your place is still being read",
      "The current match is still being read",
      "Your place is still being read",
    ]);
  });
});
