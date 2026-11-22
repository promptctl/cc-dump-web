import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { entries, fieldOf, held, kinds, list, nullable, object, optional, parse, parsed, parseJson, raw, tagged, tolerant, value } from "./json.ts";
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

describe("a refusal", () => {
  type Window = { session: string; at: { line: number; column: number } };
  const window = object<Window>({ session: value(kinds.string), at: object({ line: value(kinds.integer), column: value(kinds.integer) }) });

  it("is worded once, by each refused value's path and why, at every depth, a key that is no name quoted", () => {
    expect(() => parse(window, { session: 1, at: { line: "2", column: 3 } }, "window")).toThrow('window: session: is not a string; at.line: is not an integer');
    expect(() => parse(object({ panes: list(window) }), { panes: [{ session: "a", at: { line: 1, column: 1 } }, { session: "b" }] }, "layout")).toThrow("layout: panes.1.at: is missing");
    expect(() => parse(object({ "row-key": value(kinds.string) }), {}, "place")).toThrow('place: "row-key": is missing');
  });

  it("stops at a field declared held, which reads as its value or its refusal with what was sent, and nowhere else", () => {
    const pane = object({ session: value(kinds.string), size: held(object({ rows: value(kinds.integer) })) });
    expect(pane({ session: "a", size: { rows: "x" } }, []).value).toEqual({
      session: "a",
      size: { is: "refused", refusals: [{ at: ["size", "rows"], why: "is not an integer" }], sent: { rows: "x" } },
    });
    expect(pane({ session: "a", size: { rows: 4 } }, []).value).toEqual({ session: "a", size: { is: "read", value: { rows: 4 } } });
    // A field not held refuses the object holding it, up to the nearest held field.
    expect(held(pane)({ session: 2, size: { rows: 4 } }, ["panes", "0"]).value).toEqual({
      is: "refused",
      refusals: [{ at: ["panes", "0", "session"], why: "is not a string" }],
      sent: { session: 2, size: { rows: 4 } },
    });
  });

  it("passes a reader's own bug through a held field as it is", () => {
    const bug = new TypeError("not a function");
    const buggy = held(() => {
      throw bug;
    });
    expect(() => buggy({}, [])).toThrow(bug);
  });
});

describe("a field not sent", () => {
  it("is refused as missing, unless it is declared optional, which reads it as not sent", () => {
    expect(() => parse(object({ name: value(kinds.string) }), {}, "event")).toThrow("event: name: is missing");
    expect(parse(object({ name: optional(value(kinds.string)) }), {}, "event")).toEqual({ name: undefined });
    expect(parse(object({ name: optional(value(kinds.string)) }), { name: "x" }, "event")).toEqual({ name: "x" });
    expect(nullable(value(kinds.string))(null, []).value).toBeNull();
  });
});

describe("an unknown field", () => {
  it("is named at its path from the document's root with its value as sent, so two objects' never share a path", () => {
    const read = object({ a: object({ x: value(kinds.integer) }), b: object({ x: value(kinds.integer) }) });
    expect(read({ a: { x: 1, extra: "a's" }, b: { x: 2, extra: "b's" }, extra: true }, ["state"]).unknown).toEqual([
      { at: ["state", "extra"], value: true },
      { at: ["state", "a", "extra"], value: "a's" },
      { at: ["state", "b", "extra"], value: "b's" },
    ]);
  });

  it("is none of a refused held value's, which is shown as sent", () => {
    expect(held(object({ x: value(kinds.integer) }))({ x: "1", extra: true }, []).unknown).toEqual([]);
  });

  it("may be named __proto__ or constructor, as JSON text can say, and is a field like any other", () => {
    const json = parseJson('{"__proto__":{"polluted":true},"constructor":"c","name":"x"}', "event");
    const read = object({ name: value(kinds.string) })(json, []);
    expect(read.unknown).toEqual([
      { at: ["__proto__"], value: { polluted: true } },
      { at: ["constructor"], value: "c" },
    ]);
    expect(Object.getPrototypeOf(read.value)).toBe(Object.prototype);
    const declared = object(Object.fromEntries([["__proto__", value(kinds.integer)]]));
    expect(parse(declared, parseJson('{"__proto__":4}', "event"), "event")).toEqual(JSON.parse('{"__proto__":4}'));
    expect(fieldOf({}, "toString")).toBeUndefined();
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: value(kinds.string), nth: value(kinds.integer) });
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: value(kinds.string), on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback);

  it("keeps each field it reads, and takes one missing as the fallback's, naming nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, unknown: [], replaced: [] });
  });

  it("replaces a field it refuses alone by the fallback's, naming it by its path with why, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k", start: 4 } }, [])).toEqual({
      value: { ...fallback, name: "a" },
      unknown: [],
      replaced: [
        { at: ["on"], why: "is not a boolean" },
        { at: ["current", "nth"], why: "is missing" },
      ],
    });
  });

  it("leaves out an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toEqual({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      unknown: [],
      replaced: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
    });
  });

  it("names each field it does not read, at every depth", () => {
    expect(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]).unknown).toEqual([
      { at: ["state", "flipped"], value: 1 },
      { at: ["state", "current", "extra"], value: true },
    ]);
  });

  it("reads what is not an object as the fallback, replaced", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, unknown: [], replaced: [{ at: ["state"], why: "is not an object" }] });
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

  it("reads the variant its tag names, naming a field it does not read", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, unknown: [], replaced: [] });
    expect(place({ at: "end", key: "t1" }, [])).toEqual({ value: { at: "end" }, unknown: [{ at: ["key"], value: "t1" }], replaced: [] });
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({}, [])).toThrow("at: is missing");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
  });

  it("looks a tag up as an own key, so __proto__ and constructor are tags like any other", () => {
    type Named = { type: "__proto__"; n: number } | { type: "constructor" };
    const variants = Object.fromEntries([
      ["__proto__", { n: value(kinds.integer) }],
      ["constructor", {}],
    ]) as Parameters<typeof tagged<"type", Named>>[1];
    const named = tagged<"type", Named>("type", variants);
    expect(() => place(parseJson('{"at":"constructor"}', "place"), [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "toString" }, [])).toThrow("at: is not one of end, row");
    expect(named(parseJson('{"type":"__proto__","n":1}', "named"), []).value).toEqual(JSON.parse('{"type":"__proto__","n":1}'));
    expect(named({ type: "constructor" }, []).value).toEqual({ type: "constructor" });
  });

  it("gives a tag no variant names to its otherwise reader, whole", () => {
    const anyPlace = tagged<"at", Place | { at: string }>("at", { end: {}, row: { key: value(kinds.string) } } as never, raw as never);
    expect(anyPlace({ at: "middle", by: 2 }, []).value).toEqual({ at: "middle", by: 2 });
  });
});
