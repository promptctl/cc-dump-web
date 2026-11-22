// [LAW:single-enforcer] The one family of readers of JSON objects field by field, for the parts' messages (each part's
// format.ts), settings files (@cc-dump/config), the UI's stored items and the formatter's reads of API traffic alike,
// each refusal naming where it was. A reader only reports each field it does not read; what that field means is the
// whole document's, decided where the document is read (the entry points at the end). Imports nothing that needs
// node, so the formats a part shares with the UI use it too.
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

// A field of a JSON value looked up, not read: its own value at `name` when `json` is an object that has one, and none
// otherwise, for what picks a value to show (a line's preview), never for what a value states.
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
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// Where in a JSON value a part of it is: the field names and entry keys from its root. A list, not a dotted string,
// since a key may hold a dot or a slash (a row's key does).
export type Path = readonly string[];

// A field no reader read, at `at`, with its value, and the fields read beside it in its object, so a refusal of it can
// say what is read there.
export type Unread = { readonly at: Path; readonly value: unknown; readonly known: readonly string[] };

// A part of a value a tolerant read did not take, at `at`, and why.
export type Dropped = { readonly at: Path; readonly why: string };

// [LAW:parse-dont-validate] A value read as this build reads it, with each field it did not read. It drops nothing: a
// read that may drop is `Tolerated`, so the two never pass for each other.
export type Read<T> = { value: T; unread: readonly Unread[]; dropped?: never };
export type Tolerated<T> = { value: T; unread: readonly Unread[]; dropped: readonly Dropped[] };

// A read of the value at `at` (`undefined` where its field is missing): read, or refused whole with `Malformed`, in
// words that do not repeat `at`. Any other error is the reader's own bug, and passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;
export type Readers<T> = { [K in keyof T]-?: Reader<T[K]> };

// [LAW:types-are-the-program] A read that never refuses: what it cannot take is dropped, named, and its fallback taken.
export type Tolerant<T> = (json: unknown, at: Path) => Tolerated<T>;
export type TolerantReaders<T> = { [K in keyof T]-?: Reader<T[K]> | Tolerant<T[K]> };

// [LAW:single-enforcer] What `read` gives, or what `refused` makes of why it refused: only `Malformed` is a refusal.
export function attempt<T>(read: () => T, refused: (why: string) => T): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return refused(describe(error));
  }
}

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    if (json === undefined) throw new Malformed("is missing");
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return { value: parse(json), unread: [] };
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// What `reader` reads, as `as` makes it.
export const mapped =
  <T, U>(reader: Reader<T>, as: (value: T) => U): Reader<U> =>
  (json, at) => {
    const read = reader(json, at);
    return { value: as(read.value), unread: read.unread };
  };

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? { value: null, unread: [] } : reader(json, at);

// A field that may be missing, or one `reader` reads.
export const optional =
  <T>(reader: Reader<T>): Reader<T | undefined> =>
  (json, at) =>
    json === undefined ? { value: undefined, unread: [] } : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => ({ value: json, unread: [] });

// A field its variant leaves out, refused where it is there.
export const absent: Reader<undefined> = (json) => {
  if (json !== undefined) throw new Malformed("is not allowed here");
  return { value: undefined, unread: [] };
};

// A list, each item read by `reader`: one refused refuses the list, naming its index.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) => {
    const items = value(kinds.list)(json, at).value.map((item, index) => under(String(index), () => reader(item, [...at, String(index)])));
    return { value: items.map((item) => item.value), unread: items.flatMap((item) => item.unread) };
  };

// `read`, its refusal naming `where` it was.
function under<T>(where: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(`${where}: ${describe(error)}`) : error;
  }
}

const fieldsOf = value(kinds.object);

// [LAW:nothing-unseen] Each own field of `fields` no reader reads, with its value, reported, never judged: what it means
// is its document's.
const unreadOf = (fields: Record<string, unknown>, known: readonly string[], at: Path): Unread[] =>
  Object.keys(fields)
    .filter((key) => !known.includes(key))
    .map((key) => ({ at: [...at, key], value: fields[key], known }));

// The value of the field `key`, as an object's own: `undefined` where it has none, so a field named for a prototype's
// (`toString`, `__proto__`) is missing, not inherited.
const own = (fields: Record<string, unknown>, key: string): unknown => (Object.hasOwn(fields, key) ? fields[key] : undefined);

// An object whose fields hold together, each read by its reader: one missing or refused refuses the whole, as a match
// without its count or a window without its session is none.
export const object =
  <T>(readers: Readers<T>): Reader<T> =>
  (json, at) => {
    const fields = fieldsOf(json, at).value;
    const keys = Object.keys(readers);
    const read = keys.map((key) => [key, under(key, () => readers[key as keyof T](own(fields, key), [...at, key]))] as const);
    return { value: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T, unread: [...unreadOf(fields, keys, at), ...read.flatMap(([, { unread }]) => unread)] };
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const fields = fieldsOf(json, at).value;
    const is = under(tag, () => value(kinds.among(Object.keys(variants) as T[K][]))(own(fields, tag), [...at, tag])).value;
    const read = object<Record<string, unknown>>({ ...(variants[is] as Readers<Record<string, unknown>>), [tag]: raw })(json, at);
    return { value: read.value as T, unread: read.unread };
  };

// [LAW:parse-dont-validate] An object whose fields are each an independent choice, each read on its own: one missing is
// `fallback`'s, and one refused is `fallback`'s and dropped, named, so every other is kept. What is not an object is
// `fallback`, dropped whole.
export const tolerant =
  <T>(readers: TolerantReaders<T>, fallback: T): Tolerant<T> =>
  (json, at) => {
    if (!isObject(json)) return { value: fallback, unread: [], dropped: [{ at, why: json === undefined ? "is missing" : `is not ${kinds.object.expected}` }] };
    const keys = Object.keys(readers) as (keyof T & string)[];
    const read = keys.map((key) => {
      const field = own(json, key);
      const taken: Tolerated<T[keyof T]> = { value: fallback[key], unread: [], dropped: [] };
      if (field === undefined) return [key, taken] as const;
      const result = attempt<Read<T[keyof T]> | Tolerated<T[keyof T]>>(
        () => readers[key](field, [...at, key]),
        (why) => ({ ...taken, dropped: [{ at: [...at, key], why }] }),
      );
      return [key, result] as const;
    });
    return {
      value: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T,
      unread: [...unreadOf(json, keys, at), ...read.flatMap(([, { unread }]) => unread)],
      dropped: read.flatMap(([, { dropped = [] }]) => dropped),
    };
  };

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone, and what is
// not an object is no entries, dropped whole.
export const entries =
  <T>(reader: Reader<T> | Tolerant<T>): Tolerant<Record<string, T>> =>
  (json, at) => {
    if (!isObject(json)) return { value: {}, unread: [], dropped: [{ at, why: json === undefined ? "is missing" : `is not ${kinds.object.expected}` }] };
    const read = Object.keys(json).map((key) => {
      const result = attempt<Read<T> | Tolerated<T> | { refused: string }>(
        () => reader(json[key], [...at, key]),
        (why) => ({ refused: why }),
      );
      return [key, result] as const;
    });
    return {
      value: Object.fromEntries(read.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result.value]]))),
      unread: read.flatMap(([, result]) => ("refused" in result ? [] : result.unread)),
      dropped: read.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : (result.dropped ?? []))),
    };
  };

// [LAW:one-source-of-truth] Unread fields as the object they were, nested by path, each key its object's own (a
// `__proto__` or dotted key stays a field): the one way a reader of unread fields gives them back as JSON.
export function unreadFields(unread: readonly Unread[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const set = (into: Record<string, unknown>, key: string, held: unknown) => Object.defineProperty(into, key, { value: held, enumerable: true, writable: true, configurable: true });
  for (const { at, value } of unread) {
    const into = at.slice(0, -1).reduce((object, key) => {
      if (!Object.hasOwn(object, key)) set(object, key, {});
      return object[key] as Record<string, unknown>;
    }, root);
    set(into, at.at(-1)!, value);
  }
  return root;
}

// Where an unread field is, as a person reads it.
const said = ({ at }: Unread): string => at.join(".");

// The documents. Each entry point below is the one place what its document's unread fields mean is decided, at every
// depth, since a reader reports them all.

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way a
// part reads a JSON message. A field it does not read is another build's, and is passed over, as the message stays as
// it was sent.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return under(what, () => reader(json, [])).value;
}

// [LAW:single-enforcer] A settings file `what` read whole by `reader`: a field it does not read, at any depth, is
// refused by its path, since most often it is a setting misspelled.
export function parseExact<T>(reader: Reader<T>, json: unknown, what: string): T {
  const { value, unread } = under(what, () => reader(json, []));
  if (unread.length > 0) throw new Malformed(`${what}: ${unread.map((field) => `${said(field)}: is not read by this build, which reads ${field.known.join(", ")}`).join("; ")}`);
  return value;
}

// [LAW:single-enforcer] A value `what` read whole by `reader` with every field it does not read, at any depth, for a
// reader that shows them: the formatter, and a log line's facts.
export function readShown<T>(reader: Reader<T>, json: unknown, what: string): Read<T> {
  return under(what, () => reader(json, []));
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
