// [LAW:single-enforcer] The readers of JSON, field by field, for every JSON object the app reads: the parts' messages
// (each part's format.ts), settings files (@cc-dump/config), the UI's stored items and the API traffic the UI formats,
// each refusal naming `what` was read. Imports nothing that needs node, so the formats a part shares with the UI use it
// too.
// [LAW:one-source-of-truth] What a field this build does not read means belongs to the document it is in, not to the
// object that holds it: a reader only reports it (`Unread`), at its path, and the one function that reads each kind of
// document decides, at every depth at once: `parse`, a message; `parseExact`, a settings file; `readShown`, what the UI
// shows; and a stored item's read (ui/src/stored.ts).
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

// A field of a JSON value read leniently: the value at `name` when `json` is an object that has it, and none otherwise,
// for what a line previews of a value, which holds the field or does not. `object` is the read.
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
  list: { fits: Array.isArray as (value: unknown) => value is unknown[], expected: "a list" } as Kind<unknown[]>,
  object: { fits: isObject, expected: "an object" } as Kind<Record<string, unknown>>,
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// Where in a JSON value a part of it is: the field names, entry keys and list indexes from its root. A list, not a
// dotted string, since a key may hold a dot or a slash (a row's key does).
export type Path = readonly string[];

// A part of a stored value this build did not take, at `at`, and why.
export type Dropped = { readonly at: Path; readonly why: string };

// A field no reader read, at `at`, and what it holds.
export type Unread = { readonly at: Path; readonly value: unknown };

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it a tolerant read dropped, and each
// field no reader read.
export type Read<T> = { value: T; dropped: readonly Dropped[]; unread: readonly Unread[] };

// A read of the value at `at`: it is read, or refused whole with `Malformed`, in words that do not repeat `at`. A field
// its object does not have is handed to its reader as undefined, which JSON cannot hold. Any other error is the reader's
// own bug, and passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;
export type Readers<T> = { [K in keyof T]-?: Reader<T[K]> };

const read = <T>(value: T): Read<T> => ({ value, dropped: [], unread: [] });

// [LAW:single-enforcer] The one rule of a refusal: only `Malformed` is one, and `refused` takes it, in its words. Every
// catch of a refusal is this one, so a reader's own bug is never taken for the input's fault.
export function attempt<T>(read: () => T, refused: (why: string) => T): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return refused(describe(error));
  }
}

// `read`, its refusal said under `name`, the part of a value it reads.
const under = <T>(name: string, read: () => T): T =>
  attempt(read, (why) => {
    throw new Malformed(`${name}: ${why}`);
  });

// What is there: a field its object does not have is refused as missing.
function present(json: unknown): void {
  if (json === undefined) throw new Malformed("is missing");
}

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    present(json);
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return read(parse(json));
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => {
  present(json);
  return read(json);
};

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? read(null) : reader(json, at);

// A field that may be left out, or one `reader` reads.
export const optional =
  <T>(reader: Reader<T>): Reader<T | undefined> =>
  (json, at) =>
    json === undefined ? read(undefined) : reader(json, at);

// A field its variant must leave out (`tagged`), as an error is left out of every ending but an error's.
export const absent: Reader<never> = (json) => {
  if (json !== undefined) throw new Malformed("must be left out");
  return read(undefined as never);
};

// What `reader` reads, as `as` takes it, or refused in `as`'s words.
export const mapped =
  <T, U>(reader: Reader<T>, as: (value: T) => U): Reader<U> =>
  (json, at) => {
    const { value, ...parts } = reader(json, at);
    return { value: as(value), ...parts };
  };

const fieldsOf = value(kinds.object);

// The reads of `parts` together, as one read of `value`, which is made of them.
const joined = <T>(value: T, parts: readonly Read<unknown>[]): Read<T> => ({ value, dropped: parts.flatMap(({ dropped }) => dropped), unread: parts.flatMap(({ unread }) => unread) });

// [LAW:nothing-unseen] Each field of the object `json` read by its reader through `field`, which is handed the field's
// value, undefined where the object does not have it (one named as a prototype's member it does not), and each field
// no reader reads reported, unread, at its path. A field read as undefined is left out, as JSON leaves out what it
// cannot hold.
type Field = (key: string, reader: Reader<unknown>, value: unknown) => Read<unknown>;
function fieldsRead<T>(json: unknown, readers: Readers<T>, at: Path, field: Field): Read<T> {
  const fields = fieldsOf(json, at).value;
  const reads = Object.entries<Reader<unknown>>(readers).map(([key, reader]) => [key, field(key, reader, Object.hasOwn(fields, key) ? fields[key] : undefined)] as const);
  const value = Object.fromEntries(reads.flatMap(([key, { value }]) => (value === undefined ? [] : [[key, value]]))) as T;
  const unread = Object.entries(fields)
    .filter(([key]) => !Object.hasOwn(readers, key))
    .map(([key, value]) => ({ at: [...at, key], value }));
  const whole = joined(value, reads.map(([, read]) => read));
  return { ...whole, unread: [...unread, ...whole.unread] };
}

// An object whose fields hold together, each read by its reader: one refused refuses the whole, as a match without its
// count or a window without its session is none.
export const object =
  <T>(readers: Readers<T>): Reader<T> =>
  (json, at) =>
    fieldsRead(json, readers, at, (key, reader, value) => under(key, () => reader(value, [...at, key])));

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, and one refused as `fallback`'s and dropped, named, with what it held, so every
// other is kept. Itself missing, it is `fallback`; never refused: what is not an object is `fallback`, dropped.
export const tolerant =
  <T>(readers: Readers<T>, fallback: T): Reader<T> =>
  (json, at) => {
    const fallen = (key: string, dropped: Dropped[]): Read<unknown> => ({ value: fallback[key as keyof T], dropped, unread: [] });
    const fields: Field = (key, reader, value) =>
      value === undefined
        ? fallen(key, [])
        : attempt(
            () => reader(value, [...at, key]),
            (why) => fallen(key, [{ at: [...at, key], why }]),
          );
    return json === undefined
      ? read(fallback)
      : attempt(
          () => fieldsRead(json, readers, at, fields),
          (why) => ({ value: fallback, dropped: [{ at, why }], unread: [] }),
        );
  };

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const reads = Object.entries(fieldsOf(json, at).value).map(([key, entry]) =>
      attempt<[string, Read<T> | Dropped]>(
        () => [key, reader(entry, [...at, key])],
        (why) => [key, { at: [...at, key], why }],
      ),
    );
    const kept = reads.flatMap(([key, entry]) => ("value" in entry ? [[key, entry] as const] : []));
    const whole = joined(Object.fromEntries(kept.map(([key, { value }]) => [key, value])), kept.map(([, entry]) => entry));
    return { ...whole, dropped: [...reads.flatMap(([, entry]) => ("why" in entry ? [entry] : [])), ...whole.dropped] };
  };

// A list whose items are each read by `reader`: one refused refuses the list, naming its index.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) => {
    const reads = value(kinds.list)(json, at).value.map((item, index) => under(String(index), () => reader(item, [...at, String(index)])));
    return joined(reads.map(({ value }) => value), reads);
  };

// One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other fields.
export const tagged =
  <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> =>
  (json, at) => {
    const { [tag]: named, ...fields } = fieldsOf(json, at).value;
    const is = under(tag, () => value(kinds.among(Object.keys(variants) as T[K][]))(named, [...at, tag]).value);
    const variant = object(variants[is])(fields, at);
    return { ...variant, value: { ...variant.value, [tag]: is } as unknown as T };
  };

// A part of a read named by its path, in the words a refusal of it says.
const said = (at: Path, why: string): string => [...at, why].join(": ");

// [LAW:one-source-of-truth] Why a field not read is named, wherever it is: a stored item drops it, and a settings file
// refuses it, in these words.
export const notRead = "is not read by this build";

// [LAW:single-enforcer] The document `what` read whole by `reader`, with every field it does not read, at any depth, or
// refused with `Malformed` naming `what`: what the UI shows, which shows each field it does not read. A read that
// dropped a part of it is refused, naming each: only a stored item drops (ui/src/stored.ts).
export function readShown<T>(reader: Reader<T>, json: unknown, what: string): { value: T; unread: readonly Unread[] } {
  const { value, dropped, unread } = under(what, () => reader(json, []));
  if (dropped.length > 0) throw new Malformed(`${what}: ${dropped.map(({ at, why }) => said(at, why)).join("; ")}`);
  return { value, unread };
}

// [LAW:single-enforcer] The message `what` read whole by `reader`: the one way a part reads a JSON message. A field it
// does not read is another build's, and is passed over, since the message stays as it was sent.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return readShown(reader, json, what).value;
}

// [LAW:single-enforcer] The settings file `what` read whole by `reader`. A field it does not read, at any depth, is
// refused, named by its path, since it is most often a setting misspelled, and the part would act on a setting the user
// did not mean.
export function parseExact<T>(reader: Reader<T>, json: unknown, what: string): T {
  const { value, unread } = readShown(reader, json, what);
  if (unread.length > 0) throw new Malformed(`${what}: ${unread.map(({ at }) => said(at, notRead)).join("; ")}`);
  return value;
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
