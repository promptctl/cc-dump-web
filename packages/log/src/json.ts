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

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it that was dropped, and where each
// field its readers do not name is (`unread`), at every depth, for the document holding it to say what it means.
export type Read<T> = { value: T; dropped: readonly Dropped[]; unread: readonly Path[] };

// A read of the value at `at`, which is `undefined` for a field its object does not have: it is read, with what was
// dropped of it and what it did not read, or refused whole with `Malformed`, in words that do not repeat `at`. Every
// reader refuses a field that is not there as missing, but `optional`'s and `tolerant`'s. Any other error is the
// reader's own bug, and passes as it is.
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

const present = (json: unknown) => {
  if (json === undefined) throw new Malformed("is missing");
};

// A read of `value` that dropped nothing and read all of it.
const whole = <T>(value: T): Read<T> => ({ value, dropped: [], unread: [] });

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    present(json);
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return whole(parse(json));
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? whole(null) : reader(json, at);

// A field its object may leave out, `undefined` then, or one `reader` reads.
export const optional =
  <T>(reader: Reader<T>): Reader<T | undefined> =>
  (json, at) =>
    json === undefined ? whole(undefined) : reader(json, at);

// A field its object must leave out: one there is refused.
export const absent: Reader<undefined> = (json) => {
  if (json !== undefined) throw new Malformed("is not one it may have");
  return whole(undefined);
};

// A value there, of any type, taken as it is, for a part read on its own later (a stored item's state, by its version)
// or shown as it was sent.
export const raw: Reader<unknown> = (json) => {
  present(json);
  return whole(json);
};

const fieldsOf = value(kinds.object);
const itemsOf = value(kinds.list);

// Each part read at its name under `at`: one refused refuses the whole, named, as a match without its count or a window
// without its session is none.
function readEach<T>(parts: readonly (readonly [string, (at: Path) => Read<T>])[], at: Path): Read<T[]> {
  const reads = parts.map(([name, read]) =>
    attempt(
      () => read([...at, name]),
      (why) => refuse(name, why),
    ),
  );
  return { value: reads.map(({ value }) => value), dropped: reads.flatMap(({ dropped }) => dropped), unread: reads.flatMap(({ unread }) => unread) };
}

// Each field of the object `json` read by its reader, a field it does not have as `undefined`; every other field
// unread, where it is.
function readFields<T extends object>(json: unknown, readers: Readers<T>, at: Path): Read<T> {
  const fields = fieldsOf(json, at).value;
  const named = Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][];
  const read = readEach(
    named.map(([key, reader]) => [key, (path: Path) => reader(Object.hasOwn(fields, key) ? fields[key] : undefined, path)] as const),
    at,
  );
  return {
    value: Object.fromEntries(named.map(([key], index) => [key, read.value[index]])) as T,
    dropped: read.dropped,
    unread: [...Object.keys(fields).flatMap((key) => (Object.hasOwn(readers, key) ? [] : [[...at, key]])), ...read.unread],
  };
}

// An object whose fields hold together, each read by its reader: one refused refuses the whole.
export const object =
  <T extends object>(readers: Readers<T>): Reader<T> =>
  (json, at) =>
    readFields(json, readers, at);

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
type Variants<K extends string, T extends Record<K, string>> = { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> };
export function tagged<K extends string, T extends Record<K, string>>(tag: K, variants: Variants<K, T>): Reader<T> {
  const named = value(kinds.among(Object.keys(variants) as T[K][]));
  return (json, at) => {
    const { [tag]: is, ...fields } = fieldsOf(json, at).value;
    const variant = attempt(
      () => named(is, [...at, tag]).value,
      (why) => refuse(tag, why),
    );
    const read = readFields(fields, variants[variant] as Readers<Record<string, unknown>>, at);
    return { ...read, value: { ...read.value, [tag]: variant } as unknown as T };
  };
}

// A list each of whose items `reader` reads: one refused refuses the whole, named by its index.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) =>
    readEach(
      itemsOf(json, at).value.map((item, index) => [String(index), (path: Path) => reader(item, path)] as const),
      at,
    );

// An object read with the fields its reader does not name kept: what it reads, and every other field as it was sent.
// What the formatter shows and a log line's facts are, so a field the API adds is never lost.
export type Kept<T extends object> = { fields: T; rest: Record<string, unknown> };
export const kept =
  <T extends object>(reader: Reader<T>): Reader<Kept<T>> =>
  (json, at) => {
    const { value, dropped, unread } = reader(json, at);
    const sent = fieldsOf(json, at).value;
    const own = (path: Path) => path.length === at.length + 1;
    return {
      value: { fields: value, rest: Object.fromEntries(unread.filter(own).map((path) => [path.at(-1)!, sent[path.at(-1)!]])) },
      dropped,
      unread: unread.filter((path) => !own(path)),
    };
  };

// [LAW:types-are-the-program] What the fields a document's readers do not name mean, at every depth, the document's to
// say where it is read: a message passes over them (`parse`); a stored item drops them, each named, since they are gone
// once it is written again; a settings file refuses them, as most often a setting misspelled.
const notRead = "is not read by this build";
export const drop =
  <T>(reader: Reader<T>): Reader<T> =>
  (json, at) => {
    const { value, dropped, unread } = reader(json, at);
    return { value, dropped: [...unread.map((path) => ({ at: path, why: notRead })), ...dropped], unread: [] };
  };
export const strict =
  <T>(reader: Reader<T>): Reader<T> =>
  (json, at) => {
    const read = reader(json, at);
    if (read.unread.length > 0) throw new Malformed(read.unread.map((path) => `${path.slice(at.length).join(": ")}: ${notRead}`).join("; "));
    return read;
  };

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, so every other is kept. Never
// refused: what it cannot read as an object is `fallback`, dropped.
export function tolerant<T extends object>(readers: Readers<T>, fallback: T): Reader<T> {
  const each = Object.fromEntries(
    (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(([key, reader]) => [
      key,
      (json: unknown, at: Path): Read<T[keyof T]> =>
        json === undefined
          ? whole(fallback[key])
          : attempt(
              () => reader(json, at),
              (why) => ({ value: fallback[key], dropped: [{ at, why }], unread: [] }),
            ),
    ]),
  ) as Readers<T>;
  return (json, at) =>
    attempt(
      () => readFields(json, each, at),
      (why) => ({ value: fallback, dropped: [{ at, why }], unread: [] }),
    );
}

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const read = Object.entries(fieldsOf(json, at).value).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]), (why) => ({ refused: why }))] as const);
    return {
      value: Object.fromEntries(read.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result.value]]))),
      dropped: read.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : result.dropped)),
      unread: read.flatMap(([, result]) => ("refused" in result ? [] : result.unread)),
    };
  };

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A field it does not read is passed over: the message stays as it was sent, in its
// recording or with its sender, so it is not lost, only not read. A read that dropped a part of it did not read it
// whole, so it is refused, each part named.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return attempt(
    () => {
      const { value, dropped } = reader(json, []);
      if (dropped.length > 0) throw new Malformed(dropped.map(({ at, why }) => `${at.join(": ")}: ${why}`).join("; "));
      return value;
    },
    (why) => refuse(what, why),
  );
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
