// [LAW:single-enforcer] The one parse of JSON text into a JSON object, for every part's messages (each part's format.ts)
// and settings files (@cc-dump/config) alike, each failure naming `what` was read. Imports nothing that needs node, so
// the formats a part shares with the UI use it too.
import { describe } from "./describe.ts";
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

// A field of a JSON value read leniently: the value at `name` when `json` is an object, and none otherwise, for a read
// in which a value of any other shape simply holds no such field. `object` is the strict read.
export function fieldOf(json: unknown, name: string): unknown {
  return isObject(json) ? json[name] : undefined;
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
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

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

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return { value: parse(json), dropped: [] };
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? { value: null, dropped: [] } : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => ({ value: json, dropped: [] });

const fieldsOf = value(kinds.object);

// [LAW:nothing-unseen] A field of `json` this build does not read, at every object the readers below read: it is gone
// once the value is written again, so it is named.
const unread = (object: Record<string, unknown>, readers: object, at: Path): Dropped[] =>
  Object.keys(object)
    .filter((key) => !Object.hasOwn(readers, key))
    .map((key) => ({ at: [...at, key], why: "is not read by this build" }));

// What `read` gives, or why it refused: only `Malformed` is a refusal.
function attempt<T>(read: () => Read<T>): Read<T> | { refused: string } {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { refused: describe(error) };
  }
}

// [LAW:types-are-the-program] Why a field was not read: it is not there, or its reader refused it, and why.
type Missed = { is: "missing" } | { is: "refused"; why: string };

// Each field of the object `json` read by its reader, and each one missed taken by `otherwise`.
type Otherwise<T> = (key: keyof T & string, missed: Missed) => Read<T[keyof T]>;
function readFields<T>(json: unknown, readers: Readers<T>, at: Path, otherwise: Otherwise<T>): Read<T> {
  const fields = fieldsOf(json, at).value;
  const read = (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(([key, reader]) => {
    if (!Object.hasOwn(fields, key)) return [key, otherwise(key, { is: "missing" })] as const;
    const result = attempt(() => reader(fields[key], [...at, key]));
    return [key, "refused" in result ? otherwise(key, { is: "refused", why: result.refused }) : result] as const;
  });
  return { value: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T, dropped: [...unread(fields, readers, at), ...read.flatMap(([, { dropped }]) => dropped)] };
}

// An object whose fields hold together, each read by its reader: one missing or refused refuses the whole, as a
// match without its count or a window without its session is none.
export const object =
  <T>(readers: Readers<T>): Reader<T> =>
  (json, at) =>
    readFields(json, readers, at, (key, missed) => {
      throw new Malformed(`${key}: ${missed.is === "missing" ? "is missing" : missed.why}`);
    });

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, so every other is kept. Never
// refused: what is not an object is `fallback`, dropped.
export const tolerant =
  <T>(readers: Readers<T>, fallback: T): Reader<T> =>
  (json, at) => {
    const read = attempt(() =>
      readFields(json, readers, at, (key, missed) => ({ value: fallback[key], dropped: missed.is === "missing" ? [] : [{ at: [...at, key], why: missed.why }] })),
    );
    return "refused" in read ? { value: fallback, dropped: [{ at, why: read.refused }] } : read;
  };

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const read = Object.entries(fieldsOf(json, at).value).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]))] as const);
    return {
      value: Object.fromEntries(read.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result.value]]))),
      dropped: read.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : result.dropped)),
    };
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const named = kinds.among(Object.keys(variants) as T[K][]);
    const { [tag]: is, ...fields } = fieldsOf(json, at).value;
    if (!named.fits(is)) throw new Malformed(`${tag}: is not ${named.expected}`);
    const read = object(variants[is])(fields, at);
    return { value: { ...read.value, [tag]: is } as unknown as T, dropped: read.dropped };
  };

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A field it does not read is another build's, and is passed over.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  try {
    return reader(json, []).value;
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(`${what}: ${describe(error)}`) : error;
  }
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
