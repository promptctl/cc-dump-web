import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { entries, fields, kinds, list, nullable, object, optional, parse, parsed, parseExact, parseJson, readShown, tagged, tolerant, unreadFields, value, whole } from "./json.ts";
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

describe("a field this build does not read", () => {
  const reader = object({ name: value(kinds.string), window: object({ id: value(kinds.string), pane: object({ index: value(kinds.integer) }) }) });
  const document = { name: "a", flipped: 1, window: { id: "w", zoomed: true, pane: { index: 0, active: false } } };

  it("is passed over in a message, as another build's", () => {
    expect(parse(reader, document, "launch")).toEqual({ name: "a", window: { id: "w", pane: { index: 0 } } });
  });

  it("is refused in a settings file, at every path, naming what is read there", () => {
    expect(() => parseExact(reader, document, "settings")).toThrow(
      "settings: flipped: is not read here; read here: name, window; window: zoomed: is not read here; read here: id, pane; window: pane: active: is not read here; read here: index",
    );
  });

  it("is returned to the view, at every path, and given back as the object it was", () => {
    const { unread } = readShown(reader, document, "body");
    expect(unread.map(({ at }) => at)).toEqual([["flipped"], ["window", "zoomed"], ["window", "pane", "active"]]);
    expect(unreadFields(unread)).toEqual({ flipped: 1, window: { zoomed: true, pane: { active: false } } });
  });

  it("is given back in its list, by its index, and a key that is a prototype's or holds a dot stays a field", () => {
    const { unread } = readShown(object({ routes: list(object({ to: value(kinds.string) })) }), parseJson('{"routes":[{"to":"a","via":1}],"__proto__":2,"a.b":3}', "x"), "x");
    const rebuilt = unreadFields(unread);
    expect(rebuilt.routes).toEqual([{ via: 1 }]);
    expect(Object.hasOwn(rebuilt, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype);
    expect(rebuilt["a.b"]).toBe(3);
  });
});

describe("a field's read", () => {
  it("refuses a field that is not there, unless its reader is optional", () => {
    expect(() => parse(object({ name: value(kinds.string) }), {}, "event")).toThrow("event: name: is missing");
    expect(parse(object({ name: optional(value(kinds.string)) }), {}, "event")).toEqual({ name: undefined });
  });

  it("reads a field named for a prototype's key only where its object holds it", () => {
    expect(() => parse(object({ toString: value(kinds.string) }), {}, "event")).toThrow("event: toString: is missing");
  });

  it("refuses an item of a list by its index", () => {
    expect(() => parse(list(value(kinds.string)), ["a", 1, "c", 2], "names")).toThrow("names: 1: is not a string; 3: is not a string");
  });

  it("gives each field's outcome, so a field that read is kept beside one that did not", () => {
    const read = fields({ id: value(kinds.string), name: value(kinds.string), size: optional(value(kinds.integer)) })({ id: "t1", name: 7 }, []).value.fields;
    expect(read.id).toMatchObject({ is: "read", value: "t1" });
    expect(read.name).toEqual({ is: "refused", refusals: [{ at: ["name"], why: "is not a string" }] });
    expect(read.size).toMatchObject({ is: "read", value: undefined });
    expect(fields({ id: value(kinds.string) })({}, ["block"]).value.fields.id).toEqual({ is: "missing", at: ["block", "id"] });
  });

  it("names a refusal at depth once, at its own path", () => {
    const read = fields({ input: fields({ subagent_type: optional(value(kinds.string)) }) })({ input: { subagent_type: 5 } }, []).value;
    expect(whole(read)).toEqual({ is: "refused", refusals: [{ at: ["input", "subagent_type"], why: "is not a string" }] });
    expect(() => parse(object({ input: object({ subagent_type: value(kinds.string) }) }), { input: { subagent_type: 5 } }, "block")).toThrow("block: input: subagent_type: is not a string");
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: value(kinds.string), nth: value(kinds.integer) });
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: value(kinds.string), on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback);

  it("keeps each field it reads, and takes one missing as the fallback's, naming nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, unread: [], dropped: [] });
  });

  it("drops a field it refuses alone, by its path, with why, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k", start: 4 } }, []).dropped).toEqual([
      { at: ["on"], why: "is not a boolean" },
      { at: ["current", "nth"], why: "is missing" },
    ]);
  });

  it("drops an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toMatchObject({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      dropped: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
    });
  });

  it("reports each field it does not read, at every depth, as unread", () => {
    expect(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]).unread.map(({ at }) => at)).toEqual([
      ["state", "flipped"],
      ["state", "current", "extra"],
    ]);
  });

  it.each([
    ["nothing", undefined],
    ["a string", "x"],
    ["a list", [1]],
  ])("reads %s as the fallback, dropped", (_, json) => {
    expect(read(json, ["state"])).toEqual({ value: fallback, unread: [], dropped: [{ at: ["state"], why: "is not an object" }] });
    expect(entries(value(kinds.boolean))(json, ["folds"])).toEqual({ value: {}, unread: [], dropped: [{ at: ["folds"], why: "is not an object" }] });
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
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, unread: [], dropped: [] });
    expect(place({ at: "end", key: "t1" }, []).unread).toMatchObject([{ at: ["key"], value: "t1" }]);
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(() => place({}, ["place"])).toThrow("place: at: is missing");
    expect(nullable(place)(null, [])).toEqual({ value: null, unread: [], dropped: [] });
  });
});
