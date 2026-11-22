import { readWith } from "../testing.ts";
import { describe, expect, it } from "vitest";
import { positionAt, presence, rankBefore, rankOf, resolve, type At, type Placed, type Position } from "./position.ts";
import type { Keys, Pending } from "./rows.ts";

// Three rows of 100, 50 and 300 pixels.
const rows: Placed[] = [
  { key: "a", start: 0, size: 100 },
  { key: "b", start: 100, size: 50 },
  { key: "c", start: 150, size: 300 },
];
const placed = (index: number) => rows[index];
const rowAt = (offset: number) => rows.findLast((row) => row.start <= offset);

// The rows listed, a, b and c; and every row, which holds `hidden/first` before a, hidden as a category hides it, and
// `b/hidden` after b. The listed keys place a hidden row at the row listed before it, and the first at none (Keys).
const every = ["hidden/first", "a", "b", "b/hidden", "c"];
const listed: Keys = {
  at: (index) => rows[index]!.key,
  indexOf: (key) => new Map([["a", 0], ["b", 1], ["b/hidden", 1], ["c", 2]]).get(key),
};
const everyIndexOf = (key: string) => {
  const index = every.indexOf(key);
  return index === -1 ? undefined : index;
};
const at = (key: string, offset = 0): Position => ({ at: "row", key, offset });
// Where `position` stands among the listed rows, with `pending` saying what can still bring a key.
const judged = (position: Position, pending: (key: string) => Pending | undefined = () => undefined) => presence(position, listed, everyIndexOf, readWith(pending));

describe("where a position stands", () => {
  it("is the start or the end as it is", () => {
    expect([judged({ at: "start" }), judged({ at: "end" })]).toEqual([{ at: "start" }, { at: "end" }]);
  });

  it("is a row's own place, with the offset into it", () => {
    expect(judged(at("c", 20))).toEqual({ at: "row", index: 2, offset: 20 });
  });

  it("is the row listed before a hidden one, standing in for it, and the start for one hidden before them all", () => {
    expect(judged(at("b/hidden", 30))).toEqual({ at: "past", index: 1 });
    expect(judged(at("hidden/first"))).toEqual({ at: "start" });
  });

  it("is the nearest row a key is inside, the longest of its prefixes cut at a slash, as a block the formatter replaced stands at its group", () => {
    expect(judged(at("c/body"))).toEqual({ at: "past", index: 2 });
    expect(judged(at("b/hidden/so-far"))).toEqual({ at: "past", index: 1 });
  });

  it("stands at the row a key is inside before asking whether the read can bring it, so a body replaced while its exchange runs is not waited for", () => {
    expect(judged(at("c/body"), () => "reading")).toEqual({ at: "past", index: 2 });
  });

  it("is pending, inside no row, by what can still bring it, and gone when nothing will", () => {
    expect(judged(at("d/body"), (key) => (key === "d/body" ? "reading" : undefined))).toEqual({ at: "pending", read: "reading" });
    expect(judged(at("d/body"), () => "failed")).toEqual({ at: "pending", read: "failed" });
    expect(judged(at("d/body"), () => undefined)).toEqual({ at: "gone", why: "read_ended" });
  });

  it("stands as its moment does while the moment's step is not read, wherever it is: the column shown is another's", () => {
    for (const position of [at("c", 20), { at: "end" } as const, { at: "start" } as const]) {
      expect(presence(position, listed, everyIndexOf, { at: "pending", read: "reading" })).toEqual({ at: "pending", read: "reading" });
      expect(presence(position, listed, everyIndexOf, { at: "gone", why: "read_ended" })).toEqual({ at: "gone", why: "read_ended" });
    }
    expect(presence(at("c"), listed, everyIndexOf, { at: "pending", read: "failed" })).toEqual({ at: "pending", read: "failed" });
  });

  it("ends on every key, one starting with a slash among them, and a prefix needs its slash: `ab` is not inside `a`", () => {
    for (const key of ["//", "/request/http", "", "ab/c", "a//"]) expect(judged(at(key)).at).not.toBe("pending");
    expect(judged(at("ab/c"))).toEqual({ at: "gone", why: "read_ended" });
    expect(judged(at("a//"))).toEqual({ at: "past", index: 0 });
  });
});

describe("the offset a position is at", () => {
  it("is past every offset at the end, 0 at the start, and a row's start plus the offset into it", () => {
    expect(resolve(judged({ at: "end" }), placed)).toBe(Infinity);
    expect(resolve(judged({ at: "start" }), placed)).toBe(0);
    expect(resolve(judged(at("c", 20)), placed)).toBe(170);
  });

  it("is none for a place not among the rows, read yet or not", () => {
    expect(resolve({ at: "pending", read: "reading" }, placed)).toBeUndefined();
    expect(resolve({ at: "gone", why: "read_ended" }, placed)).toBeUndefined();
  });

  it("is the end of a row shorter than the offset into it", () => {
    expect(resolve(judged(at("b", 400)), placed)).toBe(150);
  });

  it("is the end of the row standing in, where the hidden or replaced row stood, whatever the offset into it", () => {
    expect(resolve(judged(at("b/hidden", 30)), placed)).toBe(150);
    expect(resolve(judged(at("c/gone/body", 400)), placed)).toBe(450);
  });

  it("reads back from an offset: the row at the top and how far into it, or the start", () => {
    expect(positionAt(170, rowAt)).toEqual({ at: "row", key: "c", offset: 20 });
    expect(positionAt(0, rowAt)).toEqual({ at: "start" });
    expect(resolve(judged(positionAt(123, rowAt)), placed)).toBe(123);
  });
});

describe("where a place ranks among the rows", () => {
  const places: At[] = [{ at: "start" }, { at: "row", index: 2, offset: 0 }, { at: "row", index: 2, offset: 20 }, { at: "past", index: 2 }, { at: "end" }];

  it("against where the rows start: before them all, at a row's index at its very start, behind the row some way into it or past it, after them all", () => {
    expect(places.map(rankOf)).toEqual([-Infinity, 2, 2.5, 2.5, Infinity]);
  });

  it("against what the rows hold: just before a row the place is at, however far into it, so all of the row is ahead", () => {
    expect(places.map(rankBefore)).toEqual([-Infinity, 1.5, 1.5, 2.5, Infinity]);
  });
});
