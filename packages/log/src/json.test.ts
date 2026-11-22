import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import { droppedOf, entries, kinds, list, nullable, object, optional, parse, parseExact, parsed, parseJson, readShown, tagged, tagOf, tolerant, value } from "./json.ts";
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

  it("drops and names, as a stored item, each field it does not read, at every depth", () => {
    expect(droppedOf(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]))).toEqual([
      { at: ["state", "flipped"], why: "is not read by this build, which reads name, on, folds, current" },
      { at: ["state", "current", "extra"], why: "is not read by this build, which reads key, nth" },
    ]);
  });

  it("reads what is not an object as the fallback, dropped", () => {
    expect(read([1], ["state"])).toEqual({ value: fallback, dropped: [{ at: ["state"], why: "is not an object" }], unread: [] });
  });

  it("leaves out an optional field refused that the fallback has none of", () => {
    const loose = tolerant<{ name?: string }>({ name: optional(value(kinds.string)) }, {});
    expect(loose({ name: 1 }, [])).toEqual({ value: {}, dropped: [{ at: ["name"], why: "is not a string" }], unread: [] });
  });

  it("takes an optional field not sent as the fallback's, as one sent and refused is", () => {
    const loose = tolerant<{ n?: number }>({ n: optional(value(kinds.integer)) }, { n: 3 });
    expect(loose({}, [])).toEqual({ value: { n: 3 }, dropped: [], unread: [] });
    expect(loose({ n: "x" }, [])).toEqual({ value: { n: 3 }, dropped: [{ at: ["n"], why: "is not an integer" }], unread: [] });
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

  it("reads the variant its tag names, with a field it does not read", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, dropped: [], unread: [] });
    expect(place({ at: "end", key: "t1" }, ["place"])).toEqual({ value: { at: "end" }, dropped: [], unread: [{ at: ["place", "key"], value: "t1", reads: [] }] });
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(nullable(place)(null, [])).toEqual({ value: null, dropped: [], unread: [] });
  });

  it("reads a tag it has no variant for by its `otherwise`, given the whole object", () => {
    const shown = tagged<"at", Place, { at: "other"; sent: unknown }>("at", { end: {}, row: { key: value(kinds.string) } }, (json) => ({ value: { at: "other", sent: json }, dropped: [], unread: [] }));
    expect(shown({ at: "middle", key: 1 }, []).value).toEqual({ at: "other", sent: { at: "middle", key: 1 } });
    expect(shown({ key: 1 }, []).value).toEqual({ at: "other", sent: { key: 1 } });
    expect(() => shown({ at: "row" }, [])).toThrow("key: is missing");
  });
});

describe("a tag", () => {
  it("reads an object's tag apart from its other fields, and refuses a tag missing or not a string", () => {
    expect(tagOf("type")({ type: "text", text: "hi" }, []).value).toEqual({ tag: "text", fields: { text: "hi" } });
    expect(() => tagOf("type")({ text: "hi" }, [])).toThrow("type: is missing");
    expect(() => tagOf("type")({ type: 1 }, [])).toThrow("type: is not a string");
    expect(() => tagOf("type")("text", [])).toThrow("is not an object");
  });
});

describe("an object's declaration", () => {
  const read = object<{ name: string; note?: string }>({ name: value(kinds.string), note: optional(value(kinds.string)) });

  it("leaves out an optional field not sent, and refuses one sent that does not read, as it refuses a required one missing", () => {
    expect(read({ name: "a" }, []).value).toStrictEqual({ name: "a" });
    expect(read({ name: "a", note: "b" }, []).value).toEqual({ name: "a", note: "b" });
    expect(() => read({ name: "a", note: 1 }, [])).toThrow("note: is not a string");
    expect(() => read({ note: "b" }, [])).toThrow("name: is missing");
  });
});

describe("a list", () => {
  const read = list(object({ name: value(kinds.string) }));

  it("reads each item at its index, and refuses the whole at the index of one refused", () => {
    expect(read([{ name: "a" }, { name: "b", extra: 1 }], ["tools"])).toEqual({
      value: [{ name: "a" }, { name: "b" }],
      dropped: [],
      unread: [{ at: ["tools", "1", "extra"], value: 1, reads: ["name"] }],
    });
    expect(() => read([{ name: "a" }, { name: 2 }], [])).toThrow("1: name: is not a string");
    expect(() => read({ name: "a" }, [])).toThrow("is not a list");
  });
});

describe("each entry point's rule for a field no declaration names, at every depth", () => {
  const read = object({ window: object({ id: value(kinds.string) }) });
  const sent = { window: { id: "@1", size: 3 }, extra: true };

  it("passes it over in a message", () => {
    expect(parse(read, sent, "launched")).toEqual({ window: { id: "@1" } });
  });

  it("refuses it in a settings file, naming its path and what the object reads", () => {
    expect(() => parseExact(read, sent, "settings")).toThrow("settings: extra: is not read by this build, which reads window");
    expect(() => parseExact(read, { window: sent.window }, "settings")).toThrow("settings: window: size: is not read by this build, which reads id");
    expect(parseExact(read, { window: { id: "@1" } }, "settings")).toEqual({ window: { id: "@1" } });
  });

  it("names every one in a settings file, so each misspelling is found at once", () => {
    expect(() => parseExact(read, sent, "settings")).toThrow(
      "settings: extra: is not read by this build, which reads window; window: size: is not read by this build, which reads id",
    );
  });

  it("refuses in a message or a settings file what a tolerant read would drop, never reading it as its fallback", () => {
    const nested = object({ n: tolerant<{ x: number }>({ x: value(kinds.integer) }, { x: 1 }) });
    expect(() => parse(nested, { n: { x: "bad" } }, "message")).toThrow("message: n: x: is not an integer");
    expect(() => parseExact(nested, { n: { x: "bad" } }, "settings")).toThrow("settings: n: x: is not an integer");
  });

  it("drops and names it in a stored item", () => {
    expect(droppedOf(read(sent, []))).toEqual([
      { at: ["extra"], why: "is not read by this build, which reads window" },
      { at: ["window", "size"], why: "is not read by this build, which reads id" },
    ]);
  });

  it("keeps it, with its value, for the formatter to show, or says why the value was refused", () => {
    expect(readShown(read, sent)).toEqual({
      is: "read",
      read: {
        value: { window: { id: "@1" } },
        dropped: [],
        unread: [
          { at: ["extra"], value: true, reads: ["window"] },
          { at: ["window", "size"], value: 3, reads: ["id"] },
        ],
      },
    });
    expect(readShown(read, { window: { id: 1 } })).toEqual({ is: "refused", why: "window: id: is not a string" });
  });
});
