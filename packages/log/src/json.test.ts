import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { absent, drop, entries, kept, kinds, list, nullable, object, optional, parse, parseJson, parsed, strict, tagged, tolerant, value } from "./json.ts";
import { parseTraceId } from "./trace.ts";

describe("parse", () => {
  const json = parseJson('{"trace_id":"a b","name":"x"}', "event");

  it("fails with Malformed, naming the message and the field, when a parser cannot take its value", () => {
    const read = object({ trace_id: parsed(kinds.string, parseTraceId) });
    expect(() => parse(read, json, "event")).toThrow(Malformed);
    expect(() => parse(read, json, "event")).toThrow('event: trace_id: "a b" is not a word');
  });

  it("passes over a field it does not read, as another build's", () => {
    expect(parse(object({ name: value(kinds.string) }), json, "event")).toEqual({ name: "x" });
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

  it("drops a field it refuses alone, by its path, with why, and keeps the rest", () => {
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

  it("takes a missing object it reads tolerantly as the fallback's, naming nothing", () => {
    const nested = tolerant<{ inner: { on: boolean } }>({ inner: tolerant<{ on: boolean }>({ on: value(kinds.boolean) }, { on: false }) }, { inner: { on: true } });
    expect(nested({}, [])).toEqual({ value: { inner: { on: true } }, dropped: [], unread: [] });
  });

  it("reads what is not an object as the fallback, dropped", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, dropped: [{ at: ["state"], why: "is not an object" }], unread: [] });
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

  it("reads the variant its tag names, a field it does not read unread", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, dropped: [], unread: [] });
    expect(place({ at: "end", key: "t1" }, [])).toEqual({ value: { at: "end" }, dropped: [], unread: [["key"]] });
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(nullable(place)(null, [])).toEqual({ value: null, dropped: [], unread: [] });
  });

  it("refuses a field its variant must leave out", () => {
    const marked = tagged<"at", { at: "end"; key?: never } | { at: "row"; key: string }>("at", { end: { key: absent }, row: { key: value(kinds.string) } });
    expect(() => marked({ at: "end", key: "t1" }, [])).toThrow(new Malformed("key: is not one it may have"));
  });
});

describe("a list", () => {
  it("reads each item, and refuses one that does not read by its index", () => {
    const names = list(object({ name: value(kinds.string) }));
    expect(parse(names, [{ name: "a" }, { name: "b" }], "recordings")).toEqual([{ name: "a" }, { name: "b" }]);
    expect(() => parse(names, [{ name: "a" }, { name: 2 }], "recordings")).toThrow(new Malformed("recordings: 1: name: is not a string"));
    expect(() => parse(names, {}, "recordings")).toThrow(new Malformed("recordings: is not a list"));
  });
});

describe("a field an object's readers do not name", () => {
  const window = object({ id: value(kinds.string) });
  const item = object({ name: value(kinds.string), window });
  const json = { name: "x", extra: 1, window: { id: "@1", more: true } };

  it("is unread where it is, at every depth, for the document to say what it means", () => {
    expect(item(json, ["at"])).toEqual({ value: { name: "x", window: { id: "@1" } }, dropped: [], unread: [["at", "extra"], ["at", "window", "more"]] });
  });

  it("is kept as the rest of the object holding it, where its read asks", () => {
    expect(kept(item)(json, [])).toEqual({ value: { fields: { name: "x", window: { id: "@1" } }, rest: { extra: 1 } }, dropped: [], unread: [["window", "more"]] });
  });

  it("is passed over in a message, dropped and named in a stored item, and refused in a settings file", () => {
    expect(parse(item, json, "launched")).toEqual({ name: "x", window: { id: "@1" } });
    expect(drop(item)(json, ["state"])).toEqual({
      value: { name: "x", window: { id: "@1" } },
      dropped: [
        { at: ["state", "extra"], why: "is not read by this build" },
        { at: ["state", "window", "more"], why: "is not read by this build" },
      ],
      unread: [],
    });
    expect(() => parse(strict(item), json, "settings")).toThrow(new Malformed("settings: extra: is not read by this build; window: more: is not read by this build"));
  });
});

describe("a message read whole", () => {
  it("is refused when its reader dropped a part of it, each part named", () => {
    expect(() => parse(drop(object({ name: value(kinds.string) })), { name: "x", extra: 1 }, "item")).toThrow(new Malformed("item: extra: is not read by this build"));
  });
});

describe("a field its object does not have", () => {
  it("is missing though its name is one every object inherits", () => {
    expect(() => parse(object({ constructor: value(kinds.string) }), {}, "event")).toThrow(new Malformed("event: constructor: is missing"));
  });

  it("is refused as missing by every reader but optional's, which reads it as undefined", () => {
    expect(() => parse(object({ name: value(kinds.string) }), {}, "event")).toThrow(new Malformed("event: name: is missing"));
    expect(parse(object({ name: optional(value(kinds.string)) }), {}, "event")).toEqual({ name: undefined });
    expect(() => parse(object({ name: optional(value(kinds.string)) }), { name: 1 }, "event")).toThrow(new Malformed("event: name: is not a string"));
  });
});
