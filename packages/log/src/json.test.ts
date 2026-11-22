import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { entries, kinds, nullable, object, optional, parse, parsed, parseJson, tagged, tolerant, value } from "./json.ts";
import { parseTraceId } from "./trace.ts";

describe("parse", () => {
  const json = parseJson('{"trace_id":"a b","name":"x"}', "event");

  it("fails with Malformed, naming the message and the field, when a parser cannot take its value", () => {
    const read = object({ trace_id: parsed(kinds.string, parseTraceId) }, "pass");
    expect(() => parse(read, json, "event")).toThrow(Malformed);
    expect(() => parse(read, json, "event")).toThrow('event: trace_id: "a b" is not a word');
  });

  it("passes over a field it does not read, as another build's", () => {
    expect(parse(object({ name: value(kinds.string) }, "pass"), json, "event")).toEqual({ name: "x" });
  });

  it("passes a parser's own bug as it is, so it is not taken for the sender's fault", () => {
    const bug = new TypeError("not a function");
    const buggy = object({
      name: parsed(kinds.string, () => {
        throw bug;
      }),
    }, "pass");
    expect(() => parse(buggy, json, "event")).toThrow(bug);
  });

  it("fails with Malformed for text that is not JSON", () => {
    expect(() => parseJson("{", "event")).toThrow(Malformed);
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: value(kinds.string), nth: value(kinds.integer) }, "drop");
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: value(kinds.string), on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback, "drop");

  it("keeps each field it reads, and takes one missing as the fallback's, naming nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, dropped: [] });
  });

  it("drops a field it refuses alone, by its path, with why, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k", start: 4 } }, [])).toEqual({
      value: { ...fallback, name: "a" },
      dropped: [
        { at: ["on"], why: "is not a boolean" },
        { at: ["current"], why: "nth: is missing" },
      ],
    });
  });

  it("drops an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toEqual({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      dropped: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
    });
  });

  it("names each field it does not read, at every depth", () => {
    expect(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]).dropped).toEqual([
      { at: ["state", "flipped"], why: "is not read by this build" },
      { at: ["state", "current", "extra"], why: "is not read by this build" },
    ]);
  });

  it("reads what is not an object as the fallback, dropped", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, dropped: [{ at: ["state"], why: "is not an object" }] });
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
      "drop",
    );
    expect(() => buggy({ name: "a" }, [])).toThrow(bug);
  });
});

describe("a tagged read", () => {
  type Place = { at: "end" } | { at: "row"; key: string };
  const place = tagged<"at", Place>("at", { end: {}, row: { key: value(kinds.string) } }, "drop");

  it("reads the variant its tag names, naming a field it does not read", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, dropped: [] });
    expect(place({ at: "end", key: "t1" }, [])).toEqual({ value: { at: "end" }, dropped: [{ at: ["key"], why: "is not read by this build" }] });
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(nullable(place)(null, [])).toEqual({ value: null, dropped: [] });
  });

  it("keeps the fields of the variant it does not read, when asked to", () => {
    const kept = tagged<"at", Place>("at", { end: {}, row: { key: value(kinds.string) } }, "keep");
    expect(kept({ at: "row", key: "t1", offset: 3 }, [])).toEqual({ value: { fields: { at: "row", key: "t1" }, rest: { offset: 3 } }, dropped: [] });
  });
});

describe("a field an object's readers do not name", () => {
  const readers = { name: value(kinds.string) };
  const json = { name: "x", extra: 1, more: true };

  it("is passed over, dropped and named, kept as the rest, or refused, as the caller says", () => {
    expect(object(readers, "pass")(json, ["at"])).toEqual({ value: { name: "x" }, dropped: [] });
    expect(object(readers, "drop")(json, ["at"])).toEqual({
      value: { name: "x" },
      dropped: [
        { at: ["at", "extra"], why: "is not read by this build" },
        { at: ["at", "more"], why: "is not read by this build" },
      ],
    });
    expect(object(readers, "keep")(json, ["at"])).toEqual({ value: { fields: { name: "x" }, rest: { extra: 1, more: true } }, dropped: [] });
    expect(() => parse(object(readers, "refuse"), json, "settings")).toThrow(new Malformed("settings: extra, more: are not read by this build, which reads name"));
  });
});

describe("a field its object does not have", () => {
  it("is refused as missing by every reader but optional's, which reads it as undefined", () => {
    expect(() => parse(object({ name: value(kinds.string) }, "pass"), {}, "event")).toThrow(new Malformed("event: name: is missing"));
    expect(parse(object({ name: optional(value(kinds.string)) }, "pass"), {}, "event")).toEqual({ name: undefined });
    expect(() => parse(object({ name: optional(value(kinds.string)) }, "pass"), { name: 1 }, "event")).toThrow(new Malformed("event: name: is not a string"));
  });
});
