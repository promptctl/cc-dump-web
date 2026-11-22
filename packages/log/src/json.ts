// [LAW:single-enforcer] The one parse of JSON text into a JSON object, for every part's messages (each part's format.ts)
// and settings files (@cc-dump/config) alike, each failure naming `what` was read. Imports nothing that needs node, so
// the formats a part shares with the UI use it too.
import { Malformed } from "./failure.ts";

// What JSON text can say: what `JSON.stringify` encodes, and `JSON.parse` gives back, as it was.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Malformed(`${what}: is not JSON`, { cause: error });
  }
}

const isObject = (json: unknown): json is Record<string, unknown> => typeof json === "object" && json !== null && !Array.isArray(json);

export function jsonObject(json: unknown, what: string): Record<string, unknown> {
  if (!isObject(json)) throw new Malformed(`${what}: is not an object`);
  return json;
}

// A field of a JSON value read leniently: the value at `name` when `json` is an object, and none otherwise, for a read
// in which a value of any other shape simply holds no such field. `fields` is the strict read.
export function fieldOf(json: unknown, name: string): unknown {
  return isObject(json) ? json[name] : undefined;
}

// A JSON type a value must have: its test, and its name in an error.
export type Kind<T> = { fits: (value: unknown) => value is T; expected: string };

// [LAW:single-enforcer] The kinds every read below takes, so a strict read and a kept one name a value's type alike.
export const kinds = {
  string: { fits: (value): value is string => typeof value === "string", expected: "a string" } as Kind<string>,
  boolean: { fits: (value): value is boolean => typeof value === "boolean", expected: "a boolean" } as Kind<boolean>,
  integer: { fits: Number.isSafeInteger as (value: unknown) => value is number, expected: "an integer" } as Kind<number>,
  number: { fits: Number.isFinite as (value: unknown) => value is number, expected: "a number" } as Kind<number>,
  strings: { fits: (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"), expected: "a list of strings" } as Kind<string[]>,
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// The fields of `what`, a JSON object, each read as the JSON type it must have, or an error naming it. `read` takes
// any type a part's format has a test for, and `parsed` any it has a parser for, failing in the parser's words. A parser
// throws `Malformed` for a value it cannot take; any other error is the parser's own bug, and passes as it is.
export function fields(json: unknown, what: string) {
  const object = jsonObject(json, what);
  const read = <T>(name: string, fits: (value: unknown) => value is T, expected: string): T => {
    const value = object[name];
    if (!fits(value)) throw new Malformed(`${what}: ${name} is not ${expected}`);
    return value;
  };
  const kind = <T>(name: string, { fits, expected }: Kind<T>): T => read(name, fits, expected);
  const parsed = <T>(name: string, parse: (value: unknown) => T): T => {
    try {
      return parse(object[name]);
    } catch (error) {
      throw error instanceof Malformed ? new Malformed(`${what}: ${name}`, { cause: error }) : error;
    }
  };
  return {
    read,
    parsed,
    object: (name: string) => jsonObject(object[name], `${what}: ${name}`),
    string: (name: string) => kind(name, kinds.string),
    boolean: (name: string) => kind(name, kinds.boolean),
    integer: (name: string) => kind(name, kinds.integer),
    oneOf: <T extends string>(name: string, values: Record<T, true>) => kind(name, kinds.among(Object.keys(values) as T[])),
    strings: (name: string) => kind(name, kinds.strings),
  };
}

// Where in a JSON value a part of it is: the field names and entry keys from its root. A list, not a dotted string,
// since a key may hold a dot or a slash (a row's key does).
export type Path = readonly string[];

// A part of a stored value this build did not take, at `at`, and why.
export type Dropped = { readonly at: Path; readonly why: string };

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it that was dropped.
export type Read<T> = { value: T; dropped: readonly Dropped[] };

// A read of the value at `at`: it is read, with what was dropped of it, or refused whole with `Malformed`, in words
// that do not repeat `at`. Any other error is the reader's own bug, and passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;
export type Readers<T> = { [K in keyof T]-?: Reader<T[K]> };

// A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const value =
  <K, T = K>(kind: Kind<K>, parse: (value: K) => T = (value) => value as unknown as T): Reader<T> =>
  (json) => {
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return { value: parse(json), dropped: [] };
  };

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? { value: null, dropped: [] } : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => ({ value: json, dropped: [] });

// [LAW:nothing-unseen] A field of `json` this build does not read, at every object either reader below reads: it is
// gone once the value is written again, so it is named.
const unread = (object: Record<string, unknown>, readers: object, at: Path): Dropped[] =>
  Object.keys(object)
    .filter((key) => !Object.hasOwn(readers, key))
    .map((key) => ({ at: [...at, key], why: "is not read by this build" }));

// The object a reader below reads, or a refusal in a reader's words.
function fieldsOf(json: unknown): Record<string, unknown> {
  if (!isObject(json)) throw new Malformed("is not an object");
  return json;
}

// What `read` gives, or why it refused: only `Malformed` is a refusal.
function attempt<T>(read: () => Read<T>): Read<T> | { refused: string } {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { refused: error.message };
  }
}

// Each field of `fields` read by its reader, and one missing (`why` none) or refused taken by `otherwise`.
type Otherwise<T> = (key: keyof T & string, why: string | undefined) => Read<T[keyof T]>;
function readFields<T>(fields: Record<string, unknown>, readers: Readers<T>, at: Path, otherwise: Otherwise<T>): Read<T> {
  const read = (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(([key, reader]) => {
    if (!Object.hasOwn(fields, key)) return [key, otherwise(key, undefined)] as const;
    const result = attempt(() => reader(fields[key], [...at, key]));
    return [key, "refused" in result ? otherwise(key, result.refused) : result] as const;
  });
  return { value: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T, dropped: [...unread(fields, readers, at), ...read.flatMap(([, { dropped }]) => dropped)] };
}

// An object whose fields hold together, each read by its reader: one missing or refused refuses the whole, as a
// match without its count or a window without its session is none.
export const object =
  <T>(readers: Readers<T>): Reader<T> =>
  (json, at) =>
    readFields(fieldsOf(json), readers, at, (key, why) => {
      throw new Malformed(`${key}: ${why ?? "is missing"}`);
    });

// [LAW:parse-dont-validate] An object whose fields are each an independent choice: each is read on its own, and one
// missing is `fallback`'s, one refused is `fallback`'s and dropped, so every other is kept. Never refused: no value at
// all (`undefined`, as of nothing stored) is `fallback`, and what is not an object is `fallback`, dropped.
export const kept =
  <T>(readers: Readers<T>, fallback: T): Reader<T> =>
  (json, at) =>
    isObject(json)
      ? readFields(json, readers, at, (key, why) => ({ value: fallback[key], dropped: why === undefined ? [] : [{ at: [...at, key], why }] }))
      : { value: fallback, dropped: json === undefined ? [] : [{ at, why: "is not an object" }] };

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const read = Object.entries(fieldsOf(json)).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]))] as const);
    return {
      value: Object.fromEntries(read.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result.value]]))),
      dropped: read.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : result.dropped)),
    };
  };

// One of a union told apart by its field `tag`, each variant an `object` of its other fields.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const named = kinds.among(Object.keys(variants) as T[K][]);
    const is = fieldsOf(json)[tag];
    if (!named.fits(is)) throw new Malformed(`${tag}: is not ${named.expected}`);
    return object<T>({ ...variants[is], [tag]: value(kinds.among([is])) } as unknown as Readers<T>)(json, at);
  };
