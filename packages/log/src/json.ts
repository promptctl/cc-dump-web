// [LAW:single-enforcer] The one reader family for every JSON document the app receives: the parts' messages (each
// part's format.ts), log lines (line.ts), settings files (@cc-dump/config), the UI's stored items and the Messages API
// traffic its formatter shows. A field is read the same way and refused in the same words whichever document holds it;
// what a field no declaration names means is the document's kind's to say, at its entry point. Imports nothing that
// needs node, so the formats a part shares with the UI use it too.
import { describe } from "./describe.ts";
import { Malformed } from "./failure.ts";

// What JSON text can say: what `JSON.stringify` encodes, and `JSON.parse` gives back, as it was.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const isObject = (json: unknown): json is Record<string, unknown> => typeof json === "object" && json !== null && !Array.isArray(json);

// A field of a JSON value read leniently: the value at `name` when `json` is an object holding it, and none otherwise,
// for a read in which a value of any other shape simply holds no such field. `object` is the strict read. Only an own
// field is one: `toString` is no field of `{}`.
export function fieldOf(json: unknown, name: string): unknown {
  return isObject(json) && Object.hasOwn(json, name) ? json[name] : undefined;
}

// A JSON type a value must have: its test, and its name in an error.
export type Kind<T> = { fits: (value: unknown) => value is T; expected: string };

// [LAW:single-enforcer] The kinds every read below takes, so each names a value's type alike.
export const kinds = {
  string: { fits: (value): value is string => typeof value === "string", expected: "a string" } as Kind<string>,
  boolean: { fits: (value): value is boolean => typeof value === "boolean", expected: "a boolean" } as Kind<boolean>,
  integer: { fits: Number.isSafeInteger as (value: unknown) => value is number, expected: "an integer" } as Kind<number>,
  number: { fits: Number.isFinite as (value: unknown) => value is number, expected: "a number" } as Kind<number>,
  strings: { fits: (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"), expected: "a list of strings" } as Kind<string[]>,
  object: { fits: isObject, expected: "an object" } as Kind<Record<string, unknown>>,
  list: { fits: Array.isArray as (value: unknown) => value is unknown[], expected: "a list" } as Kind<unknown[]>,
  // Any value at all: what a field is that only has to be sent.
  sent: { fits: (value): value is unknown => value !== undefined, expected: "sent" } as Kind<unknown>,
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// Where in a JSON document a part of it is: the field names and entry keys from the document's root. A list, not a
// dotted string, since a key may hold a dot or a slash (a row's key does).
export type Path = readonly string[];

// [LAW:single-enforcer] A path in words: its keys joined by dots, a key that is not a name or an index quoted.
export const pathText = (at: Path): string => at.map((key) => (/^(?:[A-Za-z_$][\w$]*|\d+)$/.test(key) ? key : JSON.stringify(key))).join(".");

// Why the value at `at` was refused.
export type Refusal = { readonly at: Path; readonly why: string };

// [LAW:single-enforcer] The one wording of a refusal, whichever document holds it: each refused value's path, and why.
export const refusalText = (refusals: readonly Refusal[]): string => refusals.map(({ at, why }) => (at.length === 0 ? why : `${pathText(at)}: ${why}`)).join("; ");

// A refusal of a value holding several, each at its own path: what `object` throws when fields of it are refused.
export class Refusals extends Malformed {
  readonly refusals: readonly Refusal[];
  constructor(refusals: readonly Refusal[]) {
    super(refusalText(refusals));
    this.refusals = refusals;
  }
}

// [LAW:types-are-the-program] What a held field read as: its value, or its refusal, with what was sent, in its own place.
export type Held<T> = { readonly is: "read"; readonly value: T } | { readonly is: "refused"; readonly refusals: readonly Refusal[]; readonly sent: unknown };

// A field of the document no declaration names, at its path from the document's root, and its value as sent.
export type Unknown = { readonly at: Path; readonly value: unknown };

// [LAW:parse-dont-validate] A value read as this build reads it, whole: every field no declaration names, and each
// refused value a declaration (`orElse`, `entries`) said to replace by its fallback or to leave out.
export type Read<T> = { readonly value: T; readonly unknown: readonly Unknown[]; readonly replaced: readonly Refusal[] };

// A read of the value at `at`: it is read, or refused with `Malformed` in words that do not repeat `at`. Any other
// error is the reader's own bug, and passes as it is. A field that was not sent is read as `undefined`, which JSON
// cannot hold, so it means not sent and nothing else.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;
export type Readers<T> = { [K in keyof T]-?: Reader<T[K]> };

const just = <T>(value: T): Read<T> => ({ value, unknown: [], replaced: [] });

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    if (json === undefined) throw new Malformed("is missing");
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return just(parse(json));
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? just(null) : reader(json, at);

// A value that may not be sent, or one `reader` reads.
export const optional =
  <T>(reader: Reader<T>): Reader<T | undefined> =>
  (json, at) =>
    json === undefined ? just(undefined) : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version; a content block,
// by the formatter's own read of it).
export const raw: Reader<unknown> = (json) => just(json);

// [LAW:single-enforcer] The one place a refusal is caught inside the family: the read of a field declared held, which
// stops a refusal at itself. A refused value is shown as sent, so what it held is none of the read's unknown fields.
export const held =
  <T>(reader: Reader<T>): Reader<Held<T>> =>
  (json, at) => {
    try {
      const read = reader(json, at);
      return { ...read, value: { is: "read", value: read.value } };
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      return just({ is: "refused", refusals: error instanceof Refusals ? error.refusals : [{ at, why: describe(error) }], sent: json });
    }
  };

// [LAW:single-enforcer] Held values taken together: each one's value when every one reads, and otherwise one refusal
// joining every refusal among them, so what holds them is whole or refused, never partial.
export function joined<T>(values: readonly Held<T>[]): { is: "read"; value: T[] } | { is: "refused"; refusals: Refusal[] } {
  const refusals = values.flatMap((value) => (value.is === "refused" ? value.refusals : []));
  return refusals.length > 0 ? { is: "refused", refusals } : { is: "read", value: values.map((value) => (value as Extract<Held<T>, { is: "read" }>).value) };
}

// Several values read together, each held, joined: refused as one when any is.
function together<T>(reads: readonly (readonly [string, Read<Held<T>>])[]): Read<[string, T][]> {
  const all = joined(reads.map(([, { value }]) => value));
  if (all.is === "refused") throw new Refusals(all.refusals);
  return {
    value: reads.map(([key], index) => [key, all.value[index]!]),
    unknown: reads.flatMap(([, { unknown }]) => unknown),
    replaced: reads.flatMap(([, { replaced }]) => replaced),
  };
}

const fieldsOf = value(kinds.object);

// [LAW:nothing-unseen] Each field of `fields` no reader of `readers` names, at its path, with its value as sent.
const unknownOf = (fields: Record<string, unknown>, readers: object, at: Path): Unknown[] =>
  Object.keys(fields)
    .filter((key) => !Object.hasOwn(readers, key))
    .map((key) => ({ at: [...at, key], value: fields[key] }));

// An object whose fields hold together, each read by its reader, a field not sent read as `undefined`: one refused
// refuses the whole, as a match without its count or a window without its session is none. Every field of it
// refused is named, each at its path.
export const object =
  <T>(readers: Readers<T>): Reader<T> =>
  (json, at) => {
    const fields = fieldsOf(json, at).value;
    const read = together(
      (Object.entries(readers) as [string, Reader<unknown>][]).map(([key, reader]) => [key, held(reader)(Object.hasOwn(fields, key) ? fields[key] : undefined, [...at, key])] as const),
    );
    return { ...read, value: Object.fromEntries(read.value) as T, unknown: [...unknownOf(fields, readers, at), ...read.unknown] };
  };

// A list, each item read by `reader` at its index: one refused refuses the list, every refused item named.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) => {
    const items = value(kinds.list)(json, at).value;
    const read = together(items.map((item, index) => [String(index), held(reader)(item, [...at, String(index)])] as const));
    return { ...read, value: read.value.map(([, item]) => item) };
  };

// [LAW:parse-dont-validate] A field that is an independent choice: one not sent is `fallback`, and one refused is
// `fallback` too, the refusal named in what the read replaced, so a value holding it is whole.
export const orElse =
  <T>(reader: Reader<T>, fallback: T): Reader<T> =>
  (json, at) => {
    if (json === undefined) return just(fallback);
    const read = held(reader)(json, at);
    return read.value.is === "read" ? { ...read, value: read.value.value } : { ...just(fallback), replaced: read.value.refusals };
  };

// An object whose fields are each an independent choice, each `orElse` its fallback's, and whole `fallback` when it is
// no object of them, so a stored item one build of the UI wrote reads, field by field, in any other.
export const tolerant = <T>(readers: Readers<T>, fallback: T): Reader<T> =>
  orElse(object(Object.fromEntries((Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(([key, reader]) => [key, orElse(reader, fallback[key])])) as Readers<T>), fallback);

// A map whose entries are each an independent choice, each read by `reader`: one refused is left out alone, named in
// what the read replaced.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const read = Object.entries(fieldsOf(json, at).value).map(([key, entry]) => [key, held(reader)(entry, [...at, key])] as const);
    return {
      value: Object.fromEntries(read.flatMap(([key, { value }]) => (value.is === "read" ? [[key, value.value]] : []))),
      unknown: read.flatMap(([, { unknown }]) => unknown),
      replaced: read.flatMap(([, { value, replaced }]) => (value.is === "refused" ? value.refusals : replaced)),
    };
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields, the tag
// looked up as an own key, so `__proto__` or `constructor` is a tag like any other. A tag no variant has is refused.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const is = fieldOf(fieldsOf(json, at).value, tag);
    if (typeof is === "string" && Object.hasOwn(variants, is)) {
      const readers = variants[is as T[K]] as Readers<Record<string, unknown>>;
      return object({ ...readers, [tag]: raw })(json, at) as Read<T>;
    }
    throw new Refusals([{ at: [...at, tag], why: is === undefined ? "is missing" : `is not one of ${Object.keys(variants).join(", ")}` }]);
  };

// The document `what` read by `reader` from its root, or refused with `Malformed` naming `what`.
export function readDocument<T>(reader: Reader<T>, json: unknown, what: string): Read<T> {
  try {
    return reader(json, []);
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(`${what}: ${describe(error)}`) : error;
  }
}

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A field it does not read is another build's, and is passed over.
export const parse = <T>(reader: Reader<T>, json: unknown, what: string): T => readDocument(reader, json, what).value;

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);

// [LAW:single-enforcer] The one `JSON.parse` of the app's own code: a string read as the JSON value its text encodes.
export const encoded: Reader<unknown> = parsed(kinds.string, (text) => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Malformed("is not JSON", { cause: error });
  }
});

// The document `what`, JSON text, as the value it encodes, or `Malformed` naming it.
export const parseJson = (text: string, what: string): unknown => parse(encoded, text, what);
