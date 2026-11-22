import { describe, expect, it } from "vitest";
import { Malformed } from "./failure.ts";
import {
  droppedOf,
  entries,
  fields,
  fromJsonText,
  held,
  kinds,
  list,
  nullable,
  object,
  optional,
  parse,
  parsed,
  parseJson,
  parseReported,
  raw,
  readShown,
  tagged,
  tolerant,
  union,
  value,
  type Reader,
} from "./json.ts";
import { parseTraceId } from "./trace.ts";

const string = value(kinds.string);
const integer = value(kinds.integer);

// A document two objects deep: a session holding a window, each object with a field of its own.
type Window = { id: string; panes: number };
type Session = { name: string; window: Window };
const session = object<Session>({ name: string, window: object<Window>({ id: string, panes: integer }) });
const sent = { name: "s", extra: 1, window: { id: "@1", panes: 2, zoomed: true } };

describe("one wording", () => {
  const bad = { name: "s", window: { id: "@1", panes: "two" } };
  const words = "window: panes: is not an integer";

  it("refuses a field by its path from the document, then why, through every entry point", () => {
    expect(() => parse(session, bad, "launch")).toThrow(`launch: ${words}`);
    expect(() => parseReported(session, bad, "launch")).toThrow(`launch: ${words}`);
    expect(readShown(session, bad)).toEqual({ is: "refused", why: words, sent: bad });
    expect(tolerant<{ session: Session | null }>({ session }, { session: null })({ session: bad }, []).dropped).toEqual([{ at: ["session"], why: words }]);
  });

  it("names a field no declaration names by its path, with the keys its object reads", () => {
    expect(droppedOf(session(sent, []))).toEqual([
      { at: ["extra"], why: "is not read by this build, which reads name, window" },
      { at: ["window", "zoomed"], why: "is not read by this build, which reads id, panes" },
    ]);
    expect(droppedOf(object({})({ a: 1 }, []))).toEqual([{ at: ["a"], why: "is not read by this build, which reads no field" }]);
  });

  it("joins each refusal of one object", () => {
    expect(() => parse(session, { window: { id: 1 } }, "launch")).toThrow("launch: name: is missing; window: id: is not a string; panes: is missing");
  });
});

describe("each entry point at depth 2", () => {
  it("parse passes over a field it does not read, as another build's", () => {
    expect(parse(session, sent, "launch")).toEqual({ name: "s", window: { id: "@1", panes: 2 } });
  });

  it("parseReported reads on, naming each field it does not read", () => {
    expect(parseReported(session, sent, "settings")).toEqual({
      value: { name: "s", window: { id: "@1", panes: 2 } },
      unread: [
        { at: ["extra"], why: "is not read by this build, which reads name, window" },
        { at: ["window", "zoomed"], why: "is not read by this build, which reads id, panes" },
      ],
    });
  });

  it("parseReported refuses every bad value in one refusal, and names every unknown key", () => {
    expect(() => parseReported(session, { name: 1, window: { id: 2, panes: 2, zoomed: true } }, "settings")).toThrow("settings: name: is not a string; window: id: is not a string");
  });

  it("parse refuses a part a tolerant read dropped", () => {
    const view = object({ chosen: tolerant<{ on: boolean }>({ on: value(kinds.boolean) }, { on: false }) });
    expect(() => parse(view, { chosen: { on: "yes" } }, "view")).toThrow("view: chosen: on: is not a boolean");
  });

  it("readShown holds what read, with what it does not read", () => {
    expect(readShown(session, sent)).toEqual({ is: "read", read: session(sent, []) });
    expect(session(sent, []).unread.map(({ of, key, value }) => ({ of, key, value }))).toEqual([
      { of: [], key: "extra", value: 1 },
      { of: ["window"], key: "zoomed", value: true },
    ]);
  });
});

describe("a fields read", () => {
  const read = fields<{ name: string; window: Window; note?: string }>({ name: string, window: object<Window>({ id: string, panes: integer }), note: optional(string) });

  it("keeps what read beside what it refused, by its path, and what no declaration names", () => {
    const { value: whole } = read({ name: 2, window: { id: "@1", panes: 3, zoomed: true }, extra: 1 }, ["doc"]);
    expect(whole.value).toEqual({ window: { id: "@1", panes: 3 } });
    expect(whole.refused).toEqual([{ at: ["doc", "name"], is: "refused", why: "is not a string" }]);
    expect(whole.unread.map(({ of, key }) => [of, key])).toEqual([
      [["doc"], "extra"],
      [["doc", "window"], "zoomed"],
    ]);
    expect(whole.sent).toEqual({ name: 2, window: { id: "@1", panes: 3, zoomed: true }, extra: 1 });
  });

  it("nested, keeps its own refusals and unread fields", () => {
    const outer = object({ inner: read });
    const { value: doc, unread } = outer({ inner: { name: 1, window: { id: "@1", panes: 1 }, extra: 1 } }, []);
    expect(unread).toEqual([]);
    expect(doc.inner.refused).toEqual([{ at: ["inner", "name"], is: "refused", why: "is not a string" }]);
    expect(doc.inner.unread.map(({ key }) => key)).toEqual(["extra"]);
  });

  it("skips an optional field absent, refuses one sent wrong, and names a required one missing", () => {
    expect(read({ name: "a", window: { id: "@1", panes: 1 } }, []).value).toMatchObject({ value: { name: "a" }, refused: [] });
    expect(read({ name: "a", window: { id: "@1", panes: 1 }, note: 3 }, []).value.refused).toEqual([{ at: ["note"], is: "refused", why: "is not a string" }]);
    expect(read({ window: { id: "@1", panes: 1 } }, []).value.refused).toEqual([{ at: ["name"], is: "missing" }]);
  });

  it("reads a field named `__proto__` as an own key like any other", () => {
    const json = parseJson('{"__proto__":{"polluted":true},"name":"a"}', "doc");
    const own = fields<{ __proto__: string; name: string }>({ ["__proto__"]: string, name: string } as never)(json, []).value;
    expect(own.refused).toEqual([{ at: ["__proto__"], is: "refused", why: "is not a string" }]);
    const unread = fields<{ name: string }>({ name: string })(json, []).value.unread;
    expect(unread).toEqual([{ of: [], key: "__proto__", value: { polluted: true }, reads: ["name"] }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses what is not an object", () => {
    expect(() => read([1], [])).toThrow("is not an object");
  });
});

describe("a union", () => {
  type Shapes = { circle: { r: number }; square: { side: number } };
  const shape = union<"kind", Shapes>("kind", { circle: { r: integer }, square: { side: integer } });

  it("reads the variant its tag names, the tag among the keys it reads", () => {
    const read = shape({ kind: "circle", r: 2, fill: "red" }, []).value;
    expect(read).toMatchObject({ is: "known", tag: "circle", fields: { value: { r: 2 }, refused: [] } });
    expect(read.is === "known" && read.fields.unread).toEqual([{ of: [], key: "fill", value: "red", reads: ["kind", "r"] }]);
  });

  it("without `otherwise`, refuses a tag it has no variant for, missing or not a string", () => {
    expect(() => shape({ kind: "hexagon" }, [])).toThrow("kind: is not one of circle, square");
    expect(() => shape({ r: 1 }, [])).toThrow("kind: is missing");
    expect(() => shape({ kind: 1 }, [])).toThrow("kind: is not a string");
  });

  it("refuses the tags `__proto__` and `constructor`, which a plain object has, as any other it has no variant for", () => {
    expect(() => shape(parseJson('{"kind":"__proto__"}', "shape"), [])).toThrow("kind: is not one of circle, square");
    expect(() => shape({ kind: "constructor" }, [])).toThrow("kind: is not one of circle, square");
  });

  it("with `otherwise`, reads another build's variant as it says", () => {
    const open = union<"kind", Shapes, unknown>("kind", { circle: { r: integer }, square: { side: integer } }, raw);
    expect(open({ kind: "hexagon", n: 6 }, []).value).toEqual({ is: "other", tag: "hexagon", other: { kind: "hexagon", n: 6 } });
    expect(open({ kind: "constructor" }, []).value).toMatchObject({ is: "other", tag: "constructor" });
    expect(open(parseJson('{"kind":"__proto__"}', "shape"), []).value).toMatchObject({ is: "other", tag: "__proto__" });
  });

  it("reads a variant named `constructor` or `__proto__` by its own readers", () => {
    const odd = union<"kind", { constructor: { n: number } }>("kind", { constructor: { n: integer } } as never);
    expect(odd({ kind: "constructor", n: 1 }, []).value).toMatchObject({ is: "known", tag: "constructor", fields: { value: { n: 1 } } });
  });
});

describe("a tagged read", () => {
  type Place = { at: "end" } | { at: "row"; key: string };
  const place = tagged<"at", Place>("at", { end: {}, row: { key: string } });

  it("reads the variant its tag names whole, with the fields it does not read", () => {
    expect(place({ at: "row", key: "t1" }, [])).toEqual({ value: { at: "row", key: "t1" }, dropped: [], unread: [] });
    expect(droppedOf(place({ at: "end", key: "t1" }, []))).toEqual([{ at: ["key"], why: "is not read by this build, which reads at" }]);
  });

  it("refuses a tag this build has no variant for, or a variant missing a field", () => {
    expect(() => place({ at: "middle" }, [])).toThrow("at: is not one of end, row");
    expect(() => place({ at: "row" }, [])).toThrow("key: is missing");
    expect(nullable(place)(null, []).value).toBeNull();
  });
});

describe("a tolerant read", () => {
  const match = object<{ key: string; nth: number }>({ key: string, nth: integer });
  type Stored = { name: string; on: boolean; folds: Record<string, boolean>; current: { key: string; nth: number } | undefined };
  const fallback: Stored = { name: "none", on: false, folds: {}, current: undefined };
  const read = tolerant<Stored>({ name: string, on: value(kinds.boolean), folds: entries(value(kinds.boolean)), current: match }, fallback);

  it("keeps each field it reads, and takes one missing as the fallback's, naming nothing", () => {
    expect(read({ name: "a", folds: { x: true } }, [])).toEqual({ value: { ...fallback, name: "a", folds: { x: true } }, dropped: [], unread: [] });
  });

  it("drops a field it refuses alone, by its path, with why, and keeps the rest", () => {
    expect(read({ name: "a", on: "yes", current: { key: "k", start: 4 } }, [])).toMatchObject({
      value: { ...fallback, name: "a" },
      dropped: [
        { at: ["on"], why: "is not a boolean" },
        { at: ["current"], why: "nth: is missing" },
      ],
    });
  });

  it("drops an entry of a map alone, by a key that holds a dot or a slash", () => {
    expect(read({ folds: { "t1/message.0": true, "t1/tools": "open", t2: false } }, [])).toMatchObject({
      value: { ...fallback, folds: { "t1/message.0": true, t2: false } },
      dropped: [{ at: ["folds", "t1/tools"], why: "is not a boolean" }],
    });
  });

  it("names each field it does not read, at every depth", () => {
    expect(droppedOf(read({ flipped: 1, current: { key: "k", nth: 0, extra: true } }, ["state"]))).toEqual([
      { at: ["state", "flipped"], why: "is not read by this build, which reads name, on, folds, current" },
      { at: ["state", "current", "extra"], why: "is not read by this build, which reads key, nth" },
    ]);
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

describe("the leaf readers", () => {
  it("a list reads each item by its index, one refused refusing it, passing up what each does not read", () => {
    const windows = list(object<Window>({ id: string, panes: integer }));
    expect(() => windows([{ id: "@1", panes: 1 }, { id: 2 }], ["sessions"])).toThrow("1: id: is not a string; panes: is missing");
    expect(() => windows("@1", [])).toThrow("is not a list");
    expect(droppedOf(windows([{ id: "@1", panes: 1, zoomed: true }], ["sessions"]))).toEqual([
      { at: ["sessions", "0", "zoomed"], why: "is not read by this build, which reads id, panes" },
    ]);
  });

  it("a held value holds its refusal, and is never refused", () => {
    const tools = object({ tools: held(list(string)) });
    expect(tools({ tools: [1] }, []).value).toEqual({ tools: { is: "refused", why: "0: is not a string", sent: [1] } });
    expect(tools({ tools: ["a"] }, []).value).toEqual({ tools: { is: "read", read: { value: ["a"], dropped: [], unread: [] } } });
  });

  it("JSON text is read by its reader, or refused", () => {
    const text = fromJsonText(session);
    expect(text(JSON.stringify(sent), []).value).toEqual({ name: "s", window: { id: "@1", panes: 2 } });
    expect(() => text(sent, [])).toThrow("is not a string");
    expect(readShown(text, "{")).toMatchObject({ is: "refused", why: expect.stringMatching(/^is not JSON: /) });
  });

  it("a parser that cannot take its value refuses it in its words", () => {
    const read = object({ trace_id: parsed(kinds.string, parseTraceId) });
    expect(() => parse(read, parseJson('{"trace_id":"a b"}', "event"), "event")).toThrow(Malformed);
    expect(() => parse(read, parseJson('{"trace_id":"a b"}', "event"), "event")).toThrow('event: trace_id: "a b" is not a word');
  });

  it("a reader's own bug passes as it is through every entry point, not taken for the sender's fault", () => {
    const bug = new TypeError("not a function");
    const buggy: Reader<string> = () => {
      throw bug;
    };
    expect(() => parse(object({ name: buggy }), { name: "a" }, "event")).toThrow(bug);
    expect(() => readShown(buggy, "a")).toThrow(bug);
    expect(() => list(buggy)(["a"], [])).toThrow(bug);
  });

  it("text that is not JSON is refused", () => {
    expect(() => parseJson("{", "event")).toThrow(Malformed);
    expect(() => parseJson("{", "event")).toThrow(/^event: is not JSON/);
  });
});
