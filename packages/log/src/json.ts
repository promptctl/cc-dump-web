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

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it that was dropped.
export type Read<T> = { value: T; dropped: readonly Dropped[] };

// A read of the value at `at`, which is `undefined` for a field its object does not have: it is read, with what was
// dropped of it, or refused whole with `Malformed`, in words that do not repeat `at`. Every reader refuses a field
// that is not there as missing, but `optional`'s and `tolerant`'s. Any other error is the reader's own bug, and passes
// as it is.
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

// A value there, of any type, taken as it is, for a part read on its own later (a stored item's state, by its version)
// or shown as it was sent.
export const raw: Reader<unknown> = (json) => {
  present(json);
  return { value: json, dropped: [] };
};

const fieldsOf = value(kinds.object);

// An object read with its unread fields kept: what its readers read, and every other field as it was sent. What the
// object reads and `tagged` read; what the formatter shows and a log line's facts are, so a field the API adds is
// never lost. `strip`, `drop` and `strict` say what its unread fields mean instead.
export type Kept<T extends object> = { fields: T; rest: Record<string, unknown> };

// Each field of the object `json` read by its reader, a field it does not have as `undefined`, and each one its reader
// refuses taken by `refused`; every other field kept as it was sent.
type Refused<T> = (key: keyof T & string, why: string) => Read<T[keyof T]>;
function readFields<T extends object>(json: unknown, readers: Readers<T>, at: Path, refused: Refused<T>): Read<Kept<T>> {
  const fields = fieldsOf(json, at).value;
  const read = (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(
    ([key, reader]) => [key, attempt(() => reader(Object.hasOwn(fields, key) ? fields[key] : undefined, [...at, key]), (why) => refused(key, why))] as const,
  );
  return {
    value: {
      fields: Object.fromEntries(read.map(([key, { value }]) => [key, value])) as T,
      rest: Object.fromEntries(Object.entries(fields).filter(([key]) => !Object.hasOwn(readers, key))),
    },
    dropped: read.flatMap(([, { dropped }]) => dropped),
  };
}

// An object whose fields hold together, each read by its reader: one refused refuses the whole, as a match without its
// count or a window without its session is none.
export const object =
  <T extends object>(readers: Readers<T>): Reader<Kept<T>> =>
  (json, at) =>
    readFields(json, readers, at, refuse);

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
type Variants<K extends string, T extends Record<K, string>> = { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> };
export function tagged<K extends string, T extends Record<K, string>>(tag: K, variants: Variants<K, T>): Reader<Kept<T>> {
  const named = value(kinds.among(Object.keys(variants) as T[K][]));
  return (json, at) => {
    const { [tag]: is, ...fields } = fieldsOf(json, at).value;
    const variant = attempt(
      () => named(is, [...at, tag]).value,
      (why) => refuse(tag, why),
    );
    const { value: read, dropped } = readFields(fields, variants[variant] as Readers<Record<string, unknown>>, at, refuse);
    return { value: { ...read, fields: { ...read.fields, [tag]: variant } as unknown as T }, dropped };
  };
}

// [LAW:types-are-the-program] What the fields of an object its readers do not name mean, the caller's to say: a read
// of it that keeps them made a read that gives its fields alone.
export type Unread = <T extends object>(read: Reader<Kept<T>>) => Reader<T>;

const notRead = "not read by this build";

// Another build's, passed over (a part's message): the message stays as it was sent, in its recording or with its
// sender, so a field this build does not read is not lost, only not read.
export const strip: Unread = (read) => (json, at) => {
  const { value, dropped } = read(json, at);
  return { value: value.fields, dropped };
};

// [LAW:nothing-unseen] Gone once the value is written again, so each is named as dropped, where it was, at every
// depth (a stored item's).
export const drop: Unread = (read) => (json, at) => {
  const { value, dropped } = read(json, at);
  return { value: value.fields, dropped: [...Object.keys(value.rest).map((key) => ({ at: [...at, key], why: `is ${notRead}` })), ...dropped] };
};

// A mistake, refused (a settings file's, most often a setting misspelled).
export const strict: Unread = (read) => (json, at) => {
  const { value, dropped } = read(json, at);
  const others = Object.keys(value.rest);
  if (others.length > 0) throw new Malformed(`${others.join(", ")}: ${others.length === 1 ? "is" : "are"} ${notRead}, which reads ${Object.keys(value.fields).join(", ")}`);
  return { value: value.fields, dropped };
};

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, so every other is kept; a field it
// does not read is dropped. Never refused: what it cannot read as an object is `fallback`, dropped.
export function tolerant<T extends object>(readers: Readers<T>, fallback: T): Reader<T> {
  const each = Object.fromEntries(
    (Object.entries(readers) as [keyof T & string, Reader<T[keyof T]>][]).map(([key, reader]) => [key, (json: unknown, at: Path) => (json === undefined ? { value: fallback[key], dropped: [] } : reader(json, at))]),
  ) as Readers<T>;
  const read = drop((json, at) => readFields(json, each, at, (key, why) => ({ value: fallback[key], dropped: [{ at: [...at, key], why }] })));
  return (json, at) =>
    attempt(
      () => read(json, at),
      (why) => ({ value: fallback, dropped: [{ at, why }] }),
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
    };
  };

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A read that dropped a part of it did not read it whole, so it is refused too, each part
// named.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return attempt(
    () => whole(reader(json, [])),
    (why) => refuse(what, why),
  );
}

function whole<T>({ value, dropped }: Read<T>): T {
  if (dropped.length > 0) throw new Malformed(dropped.map(({ at, why }) => `${at.join(": ")}: ${why}`).join("; "));
  return value;
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
