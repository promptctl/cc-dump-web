import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { absent, entries, kinds, list, nullable, object, optional, parse, parsed, parseExact, parseJson, readShown, tagged, tolerant, value } from "./json.ts";
import { parseTraceId } from "./trace.ts";

// One document with a field no reader reads at its top and at two depths, one of them in a list.
const document = { name: "x", extra: 1, source: { type: "url", more: true, items: [{ id: "a", deeper: [2] }] } };
const reader = object({ name: value(kinds.string), source: object({ type: value(kinds.string), items: list(object({ id: value(kinds.string) })) }) });

describe("each kind of document decides what a field it does not read means, at every depth", () => {
  it("a message passes over each", () => {
    expect(parse(reader, document, "event")).toEqual({ name: "x", source: { type: "url", items: [{ id: "a" }] } });
  });

  it("a settings file refuses each, named by its path", () => {
    expect(() => parseExact(reader, document, "settings in s.json")).toThrow(
      new Malformed("settings in s.json: extra: is not read by this build; source: more: is not read by this build; source: items: 0: deeper: is not read by this build"),
    );
  });

  it("what is shown returns each, at its path, with what it holds", () => {
    expect(readShown(reader, document, "block").unread).toEqual([
      { at: ["extra"], value: 1 },
      { at: ["source", "more"], value: true },
      { at: ["source", "items", "0", "deeper"], value: [2] },
    ]);
  });

  it("a message a tolerant read dropped a part of is refused, naming each", () => {
    const stored = object({ kept: tolerant({ on: value(kinds.boolean) }, { on: false }) });
    expect(() => parse(stored, { kept: { on: "yes" } }, "event")).toThrow("event: kept: on: is not a boolean");
  });
});

describe("parse", () => {
  const json = parseJson('{"trace_id":"a b","name":"x"}', "event");

  it("fails with Malformed, naming the message and the field, when a parser cannot take its value", () => {
    const read = object({ trace_id: parsed(kinds.string, parseTraceId) });
    expect(() => parse(read, json, "event")).toThrow(Malformed);
    expect(() => parse(read, json, "event")).toThrow('event: trace_id: "a b" is not a word');
  });

  it("refuses a field it reads that is missing, as it does one named as a prototype's member, and reads an optional one as none", () => {
    expect(() => parse(object({ count: value(kinds.integer) }), {}, "event")).toThrow("event: count: is missing");
    expect(() => parse(object({ toString: value(kinds.string) }), {}, "event")).toThrow("event: toString: is missing");
    expect(parse(object({ count: optional(value(kinds.integer)) }), {}, "event")).toStrictEqual({});
  });

  it("refuses a list by the index of the item it refuses", () => {
    expect(() => parse(object({ names: list(value(kinds.string)) }), { names: ["a", 2] }, "event")).toThrow("event: names: 1: is not a string");
  });

  it("passes a parser's own bug as it is, so it is not taken for the sender's fault", () => {
    const bug = new TypeError("not a function");
    const buggy = object({
      name: parsed(kinds.string, () => {
        throw bug;
      }),
    });
    expect(() => parse(buggy, json, "event")).toThrow(bug);
  });

  it("fails with Malformed for text that is not JSON", () => {
    expect(() => parseJson("{", "event")).toThrow(Malformed);
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: value(kinds.string), nth: value(kinds.integer) });
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: value(kinds.string), on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback);

  it("keeps each field it reads, and takes one missing as the fallback's, naming nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, dropped: [], unread: [] });
  });

  it("drops a field it refuses alone, by its path, with why, and what it held with it, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k", start: 4 } }, [])).toEqual({
      value: { ...fallback, name: "a" },
      dropped: [
        { at: ["on"], why: "is not a boolean" },
        { at: ["current"], why: "nth: is missing" },
      ],
      unread: [],
    });
  });

  it("drops an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toEqual({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      dropped: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
      unread: [],
    });
  });

  it("reports each field it does not read, at every depth", () => {
    expect(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]).unread).toEqual([
      { at: ["state", "flipped"], value: 1 },
      { at: ["state", "current", "extra"], value: true },
    ]);
  });

  it("reads what is not an object as the fallback, dropped, and what is missing as the fallback", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, dropped: [{ at: ["state"], why: "is not an object" }], unread: [] });
    expect(read(undefined, ["state"])).toEqual({ value: fallback, dropped: [], unread: [] });
  });

  it("passes a reader's own bug as it is", () => {
    const bug = new TypeError("not a function");
    const buggy = tolerant<{ name: string }>(
      {
        name: () => {
          throw bug;
        },
      },
      { name: "" },
    );
    expect(() => buggy({ name: "a" }, [])).toThrow(bug);
  });
});

describe("a tagged read", () => {
  type Place = { at: "end"; key?: never } | { at: "row"; key: string };
  const place = tagged<"at", Place>("at", { end: { key: absent }, row: { key: value(kinds.string) } });

  it("reads the variant its tag names, reporting a field it does not read", () => {
    expect(parse(place, { at: "row", key: "t1" }, "place")).toEqual({ at: "row", key: "t1" });
    expect(readShown(place, { at: "row", key: "t1", offset: 2 }, "place").unread).toEqual([{ at: ["offset"], value: 2 }]);
  });

  it("refuses a tag this build has no variant for, a variant missing a field, or holding one it must leave out", () => {
    expect(() => parse(place, { at: "middle" }, "place")).toThrow("place: at: is not one of end, row");
    expect(() => parse(place, { key: "t1" }, "place")).toThrow("place: at: is missing");
    expect(() => parse(place, { at: "row" }, "place")).toThrow("place: key: is missing");
    expect(() => parse(place, { at: "end", key: "t1" }, "place")).toThrow("place: key: must be left out");
    expect(parse(nullable(place), null, "place")).toBeNull();
  });
});
