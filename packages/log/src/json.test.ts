import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { entries, kinds, list, nullable, object, optional, parse, parsed, parseExact, parseJson, readShown, tagged, tolerant, unreadFields, value } from "./json.ts";
import { parseTraceId } from "./trace.ts";

describe("parse", () => {
  const json = parseJson('{"trace_id":"a b","name":"x"}', "event");

  it("fails with Malformed, naming the message and the field, when a parser cannot take its value", () => {
    const read = object({ trace_id: parsed(kinds.string, parseTraceId) });
    expect(() => parse(read, json, "event")).toThrow(Malformed);
    expect(() => parse(read, json, "event")).toThrow('event: trace_id: "a b" is not a word');
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

describe("a document's fields this build does not read", () => {
  // An extra field at the top, and at two depths: in a nested object, and in an object in a list.
  const reader = object({ port: value(kinds.integer), proxy: object({ host: value(kinds.string), routes: list(object({ to: value(kinds.string) })) }) });
  const json = { port: 1, extra: "top", proxy: { host: "h", deep: true, routes: [{ to: "a", deeper: 2 }] } };
  const read = { port: 1, proxy: { host: "h", routes: [{ to: "a" }] } };

  it("are passed over in a message", () => {
    expect(parse(reader, json, "message")).toEqual(read);
  });

  it("are refused in a settings file, each by its path, naming what is read beside it", () => {
    expect(() => parseExact(reader, json, "settings.json")).toThrow(
      "settings.json: extra: is not read by this build, which reads port, proxy; proxy.deep: is not read by this build, which reads host, routes; proxy.routes.0.deeper: is not read by this build, which reads to",
    );
    expect(parseExact(reader, read, "settings.json")).toEqual(read);
  });

  it("are each returned, with its value, to a reader that shows them, and give back the object they were", () => {
    const shown = readShown(reader, json, "body");
    expect(shown.value).toEqual(read);
    expect(shown.unread.map(({ at, value }) => [at, value])).toEqual([
      [["extra"], "top"],
      [["proxy", "deep"], true],
      [["proxy", "routes", "0", "deeper"], 2],
    ]);
    expect(unreadFields(shown.unread)).toEqual({ extra: "top", proxy: { deep: true, routes: { 0: { deeper: 2 } } } });
  });

  it("are given back with a key named for a prototype's, or holding a dot, as a field", () => {
    const fields = unreadFields(readShown(object({}), JSON.parse('{"__proto__":{"polluted":1},"a.b":2}'), "body").unread);
    expect(Object.keys(fields)).toEqual(["__proto__", "a.b"]);
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a strict read", () => {
  it("refuses a missing field as missing, a field named for a prototype's among them, and reads `optional`'s as none", () => {
    expect(() => parse(object({ name: value(kinds.string) }), {}, "event")).toThrow("event: name: is missing");
    expect(() => parse(object({ toString: value(kinds.string) }), {}, "event")).toThrow("event: toString: is missing");
    expect(parse(object({ name: optional(value(kinds.string)) }), {}, "event")).toEqual({ name: undefined });
  });

  it("refuses a list by the index of the item it cannot read", () => {
    expect(() => parse(list(value(kinds.string)), ["a", 2], "names")).toThrow("names: 1: is not a string");
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: value(kinds.string), nth: value(kinds.integer) });
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: value(kinds.string), on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback);

  it("keeps each field it reads, and takes one missing as the fallback's, dropping nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, unread: [], dropped: [] });
  });

  it("drops a field it refuses alone, by its path, with why, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k" } }, []).dropped).toEqual([
      { at: ["on"], why: "is not a boolean" },
      { at: ["current"], why: "nth: is missing" },
    ]);
  });

  it("drops an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toEqual({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      unread: [],
      dropped: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
    });
  });

  it("reports each field it does not read, at every depth, and drops none of them: what they mean is the document's", () => {
    const tolerated = read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]);
    expect(tolerated.unread.map(({ at }) => at)).toEqual([
      ["state", "flipped"],
      ["state", "current", "extra"],
    ]);
    expect(tolerated.dropped).toEqual([]);
  });

  it("never refuses: what is not an object, or is missing, is its fallback, dropped, for `tolerant` and `entries` alike", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, unread: [], dropped: [{ at: ["state"], why: "is not an object" }] });
    expect(entries(value(kinds.boolean))(undefined, ["folds"])).toEqual({ value: {}, unread: [], dropped: [{ at: ["folds"], why: "is missing" }] });
    expect(entries(value(kinds.boolean))("x", ["folds"])).toEqual({ value: {}, unread: [], dropped: [{ at: ["folds"], why: "is not an object" }] });
  });

  it("cannot be a field of a strict read, which would lose what it drops", () => {
    // @ts-expect-error A tolerant read's drops have no place in a strict read's result.
    object({ folds: entries(value(kinds.boolean)) });
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
  type Place = { at: "end" } | { at: "row"; key: string };
  const place = tagged<"at", Place>("at", { end: {}, row: { key: value(kinds.string) } });

  it("reads the variant its tag names, reporting a field it does not read", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, unread: [] });
    expect(place({ at: "end", key: "t1" }, [])).toEqual({ value: { at: "end" }, unread: [{ at: ["key"], value: "t1", known: ["at"] }] });
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({}, [])).toThrow("at: is missing");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(nullable(place)(null, [])).toEqual({ value: null, unread: [] });
  });
});
