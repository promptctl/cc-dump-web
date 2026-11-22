// [LAW:single-enforcer] The readers of JSON for the parts' messages (each part's format.ts), settings files
// (@cc-dump/config), the UI's stored items and the formatter's reads of API traffic alike, each refusal naming `what`
// was read. Imports nothing that needs node, so the formats a part shares with the UI use it too.
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
  list: { fits: Array.isArray as (value: unknown) => value is unknown[], expected: "a list" } as Kind<unknown[]>,
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

// A read of the value at `at`, `undefined` when its object has no such field: it is read, with what was dropped of it,
// or refused whole with `Malformed`, in words that do not repeat `at`. Any other error is the reader's own bug, and
// passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;
export type Readers<T> = { [K in keyof T]-?: Reader<T[K]> };

// [LAW:single-enforcer] `read()`, or, when it is refused, `refused` with why: only `Malformed` is a refusal.
export function attempt<T, R>(read: () => T, refused: (why: string) => R): T | R {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return refused(describe(error));
  }
}

// A refusal `why` of the part of a value at `where`, said as the value's.
const refuse = (where: string, why: string): never => {
  throw new Malformed(`${where}: ${why}`);
};

// A field its object does not have, which every reader refuses but `optional`'s.
const present = (json: unknown) => {
  if (json === undefined) throw new Malformed("is missing");
};

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    present(json);
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

// A field its object may leave out, `undefined` then, or one `reader` reads.
export const optional =
  <T>(reader: Reader<T>): Reader<T | undefined> =>
  (json, at) =>
    json === undefined ? { value: undefined, dropped: [] } : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => {
  present(json);
  return { value: json, dropped: [] };
};

const fieldsOf = value(kinds.object);

// [LAW:types-are-the-program] What a field of an object its readers do not name means, the caller's to say: another
// build's, passed over (a message's); gone once the item is written again, so named as dropped (a stored item's); shown
// as it was sent, kept (the formatter's, so a field the API adds is never lost); or a mistake, refused (a settings
// file's, most often a setting misspelled).
export type Unread = "pass" | "drop" | "keep" | "refuse";

// An object read with its unread fields kept: what its readers read, and every other field as it was sent.
export type Kept<T> = { fields: T; rest: Record<string, unknown> };

const notRead = "is not read by this build";

// Each field of the object `json` read by its reader, and each one it refuses taken by `refused`, with whether the
// object has it; every other field as `unread` says.
type Refused<T> = (key: keyof T & string, why: string, has: boolean) => Read<T[keyof T]>;
function readFields<T>(json: unknown, readers: Readers<T>, at: Path, unread: Unread, refused: Refused<T>): Read<T> & { rest: Record<string, unknown> } {
  const fields = fieldsOf(json, at).value;
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !Object.hasOwn(readers, key)));
  const others = Object.keys(rest);
  if (unread === "refuse" && others.length > 0) throw new Malformed(`${others.join(", ")}: ${others.length === 1 ? "is" : "are"} not read by this build, which reads ${Object.keys(readers).join(", ")}`);
  const read = (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(
    ([key, reader]) => [key, attempt(() => reader(fields[key], [...at, key]), (why) => refused(key, why, Object.hasOwn(fields, key)))] as const,
  );
  return {
    value: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T,
    // [LAW:nothing-unseen] A field dropped is named where it was, at every depth.
    dropped: [...(unread === "drop" ? others.map((key) => ({ at: [...at, key], why: notRead })) : []), ...read.flatMap(([, { dropped }]) => dropped)],
    rest,
  };
}

// The value an object read gives: its fields, with the rest beside them when they are kept.
const given = <T>({ value, dropped, rest }: Read<T> & { rest: Record<string, unknown> }, unread: Unread): Read<T | Kept<T>> =>
  unread === "keep" ? { value: { fields: value, rest }, dropped } : { value, dropped };

// An object whose fields hold together, each read by its reader: one refused refuses the whole, as a match without its
// count or a window without its session is none.
export function object<T>(readers: Readers<T>, unread: "keep"): Reader<Kept<T>>;
export function object<T>(readers: Readers<T>, unread: Exclude<Unread, "keep">): Reader<T>;
export function object<T>(readers: Readers<T>, unread: Unread): Reader<T | Kept<T>> {
  return (json, at) => given(readFields(json, readers, at, unread, refuse), unread);
}

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, so every other is kept. Never
// refused: what it cannot read as an object is `fallback`, dropped.
export const tolerant =
  <T>(readers: Readers<T>, fallback: T, unread: Exclude<Unread, "keep">): Reader<T> =>
  (json, at) =>
    attempt(
      (): Read<T> => {
        const { value, dropped } = readFields(json, readers, at, unread, (key, why, has) => ({ value: fallback[key], dropped: has ? [{ at: [...at, key], why }] : [] }));
        return { value, dropped };
      },
      (why) => ({ value: fallback, dropped: [{ at, why }] }),
    );

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const read = Object.entries(fieldsOf(json, at).value).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]), (why) => ({ refused: why }))] as const);
    return {
      value: Object.fromEntries(read.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result.value]]))),
      dropped: read.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : result.dropped)),
    };
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
type Variants<K extends string, T extends Record<K, string>> = { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> };
export function tagged<K extends string, T extends Record<K, string>>(tag: K, variants: Variants<K, T>, unread: "keep"): Reader<Kept<T>>;
export function tagged<K extends string, T extends Record<K, string>>(tag: K, variants: Variants<K, T>, unread: Exclude<Unread, "keep">): Reader<T>;
export function tagged<K extends string, T extends Record<K, string>>(tag: K, variants: Variants<K, T>, unread: Unread): Reader<T | Kept<T>> {
  const named = value(kinds.among(Object.keys(variants) as T[K][]));
  return (json, at) => {
    const { [tag]: is, ...fields } = fieldsOf(json, at).value;
    const variant = attempt(
      () => named(is, [...at, tag]).value,
      (why) => refuse(tag, why),
    );
    const read = readFields(fields, variants[variant] as Readers<Record<string, unknown>>, at, unread, refuse);
    return given({ ...read, value: { ...read.value, [tag]: variant } as unknown as T }, unread);
  };
}

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return attempt(
    () => reader(json, []).value,
    (why) => refuse(what, why),
  );
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
