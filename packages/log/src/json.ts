// [LAW:single-enforcer] The readers of JSON for every part: the parts' messages (each part's format.ts), settings files
// (@cc-dump/config), the UI's stored items and the API traffic the formatter shows. A reader reports what it read, what
// it did not read, and what it dropped; what a field it did not read means is decided by the entry point of the
// document it is in (`parse`, `parseExact` and `readShown` here; a stored item's, `readItem` in ui/src/stored.ts).
// Imports nothing that needs node, so the formats a part shares with the UI use it too.
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

// A field of a JSON value read leniently: the value its object holds as its own at `name`, and none when it is no
// object, for a value shown, never for what a value states, which the readers below read.
export function fieldOf(json: unknown, name: string): unknown {
  return isObject(json) && Object.hasOwn(json, name) ? json[name] : undefined;
}

// A JSON type a value must have: its test, and its name in an error.
export type Kind<T> = { fits: (value: unknown) => value is T; expected: string };

const isInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isNumber = (value: unknown): value is number => Number.isFinite(value);

// [LAW:single-enforcer] The kinds every read below takes, so each names a value's type alike.
export const kinds = {
  string: { fits: (value): value is string => typeof value === "string", expected: "a string" } satisfies Kind<string>,
  boolean: { fits: (value): value is boolean => typeof value === "boolean", expected: "a boolean" } satisfies Kind<boolean>,
  integer: { fits: isInteger, expected: "an integer" } satisfies Kind<number>,
  number: { fits: isNumber, expected: "a number" } satisfies Kind<number>,
  strings: { fits: (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"), expected: "a list of strings" } satisfies Kind<string[]>,
  list: { fits: (value): value is unknown[] => Array.isArray(value), expected: "a list" } satisfies Kind<unknown[]>,
  object: { fits: isObject, expected: "an object" } satisfies Kind<Record<string, unknown>>,
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// Where in a JSON value a part of it is: the field names, entry keys and list indexes from its root. A list, not a
// dotted string, since a key may hold a dot or a slash (a row's key does).
export type Path = readonly (string | number)[];

// [LAW:one-source-of-truth] Why the value at `at` was not taken, and the one way refusals are put in words: each its
// path, then why, so a refusal reads alike wherever it comes from.
export type Refusal = { readonly at: Path; readonly why: string };
export const worded = (refusals: readonly Refusal[]): string => refusals.map(({ at, why }) => [...at, why].join(": ")).join("; ");
export type Refusals = readonly [Refusal, ...Refusal[]];
const some = (refusals: readonly Refusal[]): refusals is Refusals => refusals.length > 0;

// [LAW:types-are-the-program] A read refused, with each of its refusals at its own path: a `Malformed`, so every reader
// of a refusal takes it as one.
export class Refused extends Malformed {
  readonly refusals: Refusals;
  constructor(refusals: Refusals) {
    super(worded(refusals));
    this.refusals = refusals;
  }
}

// [LAW:nothing-unseen] A field no reader asked for, at `at`, its value, and the fields read beside it, so a document
// that refuses it can say what is read there.
export type Unread = { readonly at: Path; readonly value: unknown; readonly known: readonly string[] };

// [LAW:parse-dont-validate] A value read as this build reads it, the fields it did not read that its value does not
// hold, and what a tolerant read dropped of it.
export type Read<T> = { value: T; unread: readonly Unread[]; dropped: readonly Refusal[] };
const got = <T>(value: T): Read<T> => ({ value, unread: [], dropped: [] });

// A read of the value at `at`: it is read, or refused with `Malformed`, in words that do not repeat `at`. Any other
// error is the reader's own bug, and passes as it is. `absent`, for a reader that takes a field not there: its value.
export type Reader<T> = ((json: unknown, at: Path) => Read<T>) & { readonly absent?: () => T };
export type Readers<T> = { readonly [K in keyof T]-?: Reader<T[K]> };

// [LAW:single-enforcer] What `read` gives, or `refused` with why: only `Malformed` is a refusal, its own refusals kept
// where it has them, else one at `at`.
export function attempt<T>(read: () => T, refused: (refusals: Refusals) => T, at: Path = []): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return refused(error instanceof Refused ? error.refusals : [{ at, why: describe(error) }]);
  }
}

// [LAW:types-are-the-program] How the read of a value there came out, and how one field's did: read, refused, each
// refusal at its own path, or, for a field, not there. A fact reads only an outcome that read, so it never reaches a
// field that failed.
export type Taken<T> = ({ is: "read" } & Read<T>) | { is: "refused"; refusals: Refusals };
export type Field<T> = Taken<T> | { is: "missing"; at: Path };
export type Fields<T> = { readonly [K in keyof T]-?: Field<T[K]> };

// [LAW:one-source-of-truth] Why a field did not read: its refusals, or that it is missing.
export const refusalsOf = (field: Exclude<Field<unknown>, { is: "read" }>): Refusals => (field.is === "missing" ? [{ at: field.at, why: "is missing" }] : field.refusals);

// The value a field read, given to `read`, or `otherwise` for one that did not.
export const when = <T, R>(field: Field<T>, read: (value: T) => R, otherwise: R): R => (field.is === "read" ? read(field.value) : otherwise);

// The value at `here` read by `reader`, as its outcome.
export const taken = <T>(reader: Reader<T>, json: unknown, here: Path): Taken<T> =>
  attempt(
    (): Taken<T> => ({ is: "read", ...reader(json, here) }),
    (refusals) => ({ is: "refused", refusals }),
    here,
  );

// An object's fields, each one's outcome, and the object's own fields no reader asked for.
export class Outcomes<T> {
  readonly fields: Fields<T>;
  readonly unread: readonly Unread[];
  constructor(fields: Fields<T>, unread: readonly Unread[]) {
    this.fields = fields;
    this.unread = unread;
  }
}

// [LAW:one-type-per-behavior] The one read of an object's fields: each field by its reader, where its object holds it,
// to its own outcome. Refused only when the value is no object.
export const fields =
  <T>(readers: Readers<T>): Reader<Outcomes<T>> =>
  (json, at) => {
    if (!isObject(json)) throw new Malformed(`is not ${kinds.object.expected}`);
    const known = Object.keys(readers);
    const read = (Object.entries(readers) as [string, Reader<unknown>][]).map(([key, reader]): [string, Field<unknown>] => {
      const here = [...at, key];
      if (Object.hasOwn(json, key)) return [key, taken(reader, json[key], here)];
      return [key, reader.absent === undefined ? { is: "missing", at: here } : { is: "read", ...got(reader.absent()) }];
    });
    const unread = Object.keys(json)
      .filter((key) => !Object.hasOwn(readers, key))
      .map((key) => ({ at: [...at, key], value: json[key], known }));
    return got(new Outcomes(Object.fromEntries(read) as Fields<T>, unread));
  };

// [LAW:types-are-the-program] A value whose every field read, at every depth: each object's outcomes become the object
// they read.
export type Whole<T> = T extends Outcomes<infer U> ? { [K in keyof U]: Whole<U[K]> } : T extends readonly unknown[] ? { [I in keyof T]: Whole<T[I]> } : T;
export type Walked<T> = ({ is: "whole" } & Read<Whole<T>>) | { is: "refused"; refusals: Refusals };

// `value` with every outcome in it walked, what it did not read and dropped gathered, and each refusal in `refused`,
// once, since each lives in one field's outcome. A list none of whose items changed is the list it was.
function walked(value: unknown, seen: { unread: Unread[]; dropped: Refusal[]; refused: Refusal[] }): unknown {
  if (value instanceof Outcomes) {
    seen.unread.push(...value.unread);
    const read = (Object.entries(value.fields) as [string, Field<unknown>][]).map(([key, field]): [string, unknown] => {
      if (field.is !== "read") {
        seen.refused.push(...refusalsOf(field));
        return [key, undefined];
      }
      seen.unread.push(...field.unread);
      seen.dropped.push(...field.dropped);
      return [key, walked(field.value, seen)];
    });
    return Object.fromEntries(read);
  }
  if (!Array.isArray(value)) return value;
  const items = value.map((item: unknown) => walked(item, seen));
  return items.every((item, index) => item === value[index]) ? value : items;
}

// The whole of `value`, when every outcome in it read, or every refusal in it.
export function whole<T>(value: T): Walked<T> {
  const seen = { unread: [], dropped: [], refused: [] };
  const read = walked(value, seen) as Whole<T>;
  return some(seen.refused) ? { is: "refused", refusals: seen.refused } : { is: "whole", value: read, unread: seen.unread, dropped: seen.dropped };
}

// An object whose fields hold together, each read by its reader: one missing or refused refuses the whole, naming each,
// as a match without its count or a window without its session is none.
export const object =
  <T>(readers: Readers<T>): Reader<Whole<Outcomes<T>>> =>
  (json, at) => {
    const read = whole(fields(readers)(json, at).value);
    if (read.is === "refused") throw new Refused(read.refusals);
    return { value: read.value, unread: read.unread, dropped: read.dropped };
  };

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, so every other is kept. Never
// refused: what is not an object is `fallback`, dropped.
export const tolerant =
  <T>(readers: Readers<T>, fallback: T): Reader<T> =>
  (json, at) =>
    tolerated(readers, json, at, fallback, (each) => Object.fromEntries(each.map(([key, field]) => [key, when(field, (value) => value, fallback[key as keyof T])])) as T);

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const readers = Object.fromEntries((isObject(json) ? Object.keys(json) : []).map((key) => [key, reader])) as Readers<Record<string, T>>;
    return tolerated(readers, json, at, {}, (each) => Object.fromEntries(each.flatMap(([key, field]) => (field.is === "read" ? [[key, field.value]] : []))));
  };

// [LAW:one-type-per-behavior] A tolerant read of `json`'s fields by `readers`: the value `valueOf` makes of their
// outcomes, every field they did not read, and each refused one dropped, by its path; what is not an object, `fallback`,
// dropped.
function tolerated<T>(readers: Readers<T>, json: unknown, at: Path, fallback: T, valueOf: (each: [string, Field<T[keyof T]>][]) => T): Read<T> {
  return attempt(
    (): Read<T> => {
      const read = fields(readers)(json, at).value;
      const each = Object.entries(read.fields) as [string, Field<T[keyof T]>][];
      return {
        value: valueOf(each),
        unread: [...read.unread, ...each.flatMap(([, field]) => (field.is === "read" ? field.unread : []))],
        dropped: each.flatMap(([, field]) => (field.is === "read" ? field.dropped : field.is === "refused" ? field.refusals : [])),
      };
    },
    (refusals) => ({ value: fallback, unread: [], dropped: refusals }),
    at,
  );
}

// A list whose items hold together, each read by `reader`: one refused refuses the whole, naming each by its index.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) => {
    if (!Array.isArray(json)) throw new Malformed(`is not ${kinds.list.expected}`);
    const read = json.map((item: unknown, index) => taken(reader, item, [...at, index]));
    const refused = read.flatMap((item) => (item.is === "refused" ? item.refusals : []));
    if (some(refused)) throw new Refused(refused);
    const items = read.flatMap((item) => (item.is === "read" ? [item] : []));
    return { value: items.map(({ value }) => value), unread: items.flatMap(({ unread }) => unread), dropped: items.flatMap(({ dropped }) => dropped) };
  };

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return got(parse(json));
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// The value `reader` reads, as `as` takes it, or refused in `as`'s words.
export const mapped =
  <T, U>(reader: Reader<T>, as: (value: T) => U): Reader<U> =>
  (json, at) => {
    const read = reader(json, at);
    return { ...read, value: as(read.value) };
  };

// A value of any JSON type, as it is: a field that must be there, whatever it holds.
export const raw: Reader<unknown> = (json) => got(json);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? got(null) : reader(json, at);

// A field that may not be there, read by `reader` when it is: the one reader that takes a field not there, as none.
export const optional = <T>(reader: Reader<T>): Reader<T | undefined> => Object.assign((json: unknown, at: Path): Read<T | undefined> => reader(json, at), { absent: () => undefined });

// A field that must not be there, as in a variant of a union that has no place for it.
export const absent: Reader<undefined> = Object.assign(
  (): Read<undefined> => {
    throw new Malformed("is not allowed here");
  },
  { absent: () => undefined },
);

// A value that is one of two shapes, each read by its own reader: the first whose kind it is.
export type Shape<T> = { kind: Kind<unknown>; read: Reader<T> };
export const either =
  <A, B>(first: Shape<A>, second: Shape<B>): Reader<A | B> =>
  (json, at) => {
    if (first.kind.fits(json)) return first.read(json, at);
    if (second.kind.fits(json)) return second.read(json, at);
    throw new Malformed(`is not ${first.kind.expected} or ${second.kind.expected}`);
  };

// The field `name` of an object, read once by `kind`, and the object's other fields, for what the field decides to read
// them: a union's tag, or a field lifted out of the object it is set on.
export const apart =
  <K>(name: string, kind: Kind<K>): Reader<{ is: K; rest: Record<string, unknown> }> =>
  (json, at) => {
    if (!isObject(json)) throw new Malformed(`is not ${kinds.object.expected}`);
    const here = [...at, name];
    if (!Object.hasOwn(json, name)) throw new Refused([{ at: here, why: "is missing" }]);
    const { [name]: is, ...rest } = json;
    const read = taken(value(kind), is, here);
    if (read.is === "refused") throw new Refused(read.refusals);
    return got({ is: read.value, rest });
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const { is, rest } = apart(tag, kinds.among(Object.keys(variants) as T[K][]))(json, at).value;
    const read = object(variants[is] as Readers<unknown>)(rest, at);
    // [LAW:types-are-the-program] exception: the variant `is` names, with its tag, is a member of `T`, which no type
    // carries across a generic key.
    return { ...read, value: { ...(read.value as object), [tag]: is } as unknown as T };
  };

// A field set on `into` as its own, whatever its key, `__proto__` among them.
const define = (into: object, key: string | number, value: unknown) => Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });

// The fields `unread` hold, as the object, and the lists in it, they were: each at its path below `from`. A key a value
// holds as its own, `__proto__` or dotted, stays a field, and each index its list's: the one way a reader of unread
// fields gives them back.
export function unreadFields(unread: readonly Unread[], from: Path = []): Record<string, unknown> {
  const root: Record<string | number, unknown> = {};
  for (const { at, value } of unread) {
    const path = at.slice(from.length);
    let into = root;
    path.forEach((key, index) => {
      if (index === path.length - 1) return define(into, key, value);
      if (!Object.hasOwn(into, key)) define(into, key, typeof path[index + 1] === "number" ? [] : {});
      into = into[key] as Record<string | number, unknown>;
    });
  }
  return root;
}

// A document `what` read from its root by `read`, a refusal naming `what`.
function under<T>(what: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(`${what}: ${describe(error)}`) : error;
  }
}

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way a
// part reads a message another part sent. A field it does not read is another build's, and is passed over, as the
// message stays as it was sent.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return under(what, () => reader(json, [])).value;
}

// [LAW:no-silent-failure] A settings file `what` read whole by `reader`: a field it does not read, at any depth, is
// refused, naming what is read there, since most often it is a setting misspelled.
export function parseExact<T>(reader: Reader<T>, json: unknown, what: string): T {
  return under(what, () => {
    const read = reader(json, []);
    const unread = read.unread.map(({ at, known }) => ({ at, why: `is not read here; read here: ${known.join(", ")}` }));
    if (some(unread)) throw new Refused(unread);
    return read.value;
  });
}

// [LAW:nothing-unseen] A value read by `reader` with every field it did not read: the formatter's, which shows them,
// and a log line's, whose facts they are.
export function readShown<T>(reader: Reader<T>, json: unknown, what: string): Read<T> {
  return under(what, () => reader(json, []));
}
