// [LAW:single-enforcer] The readers of JSON for the parts' messages (each part's format.ts), settings files
// (@cc-dump/config) and the UI's stored items alike, each refusal naming `what` was read. Imports nothing that needs
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

// [LAW:nothing-unseen] A field of an object that its declaration does not name, at `at`: its value, and the fields the
// declaration reads. Every reader below reports each, at every depth, and the entry point that read the document gives
// it its meaning: a message passes over it (`parse`), a settings file refuses it (`parseExact`), a stored item drops and
// names it (`droppedOf`), and the formatter shows it (`readShown`).
export type Unread = { readonly at: Path; readonly value: unknown; readonly reads: readonly string[] };

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it a tolerant read dropped and each
// field no declaration named.
export type Read<T> = { value: T; dropped: readonly Dropped[]; unread: readonly Unread[] };

// A read of the value at `at`: it is read, with what was dropped of it and what it did not read, or refused whole with
// `Malformed`, in words that do not repeat `at`. Any other error is the reader's own bug, and passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;

// A field an object's declaration lets be absent: read by its reader when it is sent, and left out when it is not.
export type Optional<T> = { optional: Reader<T> };
export const optional = <T>(reader: Reader<T>): Optional<T> => ({ optional: reader });

// [LAW:types-are-the-program] An object's declaration: each field's reader, an optional field's `optional`, so whether a
// field may be absent is a fact of the object's type that its declaration cannot contradict.
type OptionalKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never }[keyof T];
export type Readers<T> = { [K in keyof T]-?: K extends OptionalKeys<T> ? Optional<Exclude<T[K], undefined>> : Reader<T[K]> };

const read = <T>(value: T): Read<T> => ({ value, dropped: [], unread: [] });

// [LAW:types-are-the-program] A value of `kind`, as `parse` takes it, or refused in the kind's words or the parser's.
export const parsed =
  <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> =>
  (json) => {
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return read(parse(json));
  };

// A value of `kind`, as it is.
export const value = <K>(kind: Kind<K>): Reader<K> => parsed(kind, (json) => json);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? read(null) : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = (json) => read(json);

const fieldsOf = value(kinds.object);

// What `reader` gives, or why it refused: only `Malformed` is a refusal.
function attempt<T>(reader: () => Read<T>): Read<T> | { refused: string } {
  try {
    return reader();
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { refused: describe(error) };
  }
}

// The parts' reads joined: what each dropped and did not read, in order.
const joined = (reads: readonly Read<unknown>[]) => ({ dropped: reads.flatMap(({ dropped }) => dropped), unread: reads.flatMap(({ unread }) => unread) });

// [LAW:types-are-the-program] Why a field was not read: it is not there, or its reader refused it, and why. And what
// became of a field, so taken: a value read, or none, as an optional field not sent is, with what was dropped of it.
type Missed = { is: "missing" } | { is: "refused"; why: string };
type Field<V> = { is: "read"; read: Read<V> } | { is: "absent"; dropped: readonly Dropped[] };

// Each field of the object `json` read by its declaration, an optional one not sent absent, and each one missed taken
// by `otherwise`.
type Otherwise<T> = (key: keyof T & string, missed: Missed) => Field<T[keyof T]>;
function readFields<T>(json: unknown, readers: Readers<T>, at: Path, otherwise: Otherwise<T>): Read<T> {
  const fields = fieldsOf(json, at).value;
  const declared = Object.entries(readers) as [keyof T & string, Reader<T[keyof T]> | Optional<T[keyof T]>][];
  const taken = declared.map(([key, declaration]): [string, Field<T[keyof T]>] => {
    const reader = typeof declaration === "function" ? declaration : declaration.optional;
    if (!Object.hasOwn(fields, key)) return [key, typeof declaration === "function" ? otherwise(key, { is: "missing" }) : { is: "absent", dropped: [] }];
    const result = attempt(() => reader(fields[key], [...at, key]));
    return [key, "refused" in result ? otherwise(key, { is: "refused", why: result.refused }) : { is: "read", read: result }];
  });
  const reads = Object.keys(readers);
  const unread = Object.keys(fields)
    .filter((key) => !Object.hasOwn(readers, key))
    .map((key): Unread => ({ at: [...at, key], value: fields[key], reads }));
  const kept = taken.flatMap(([key, field]) => (field.is === "read" ? [[key, field.read] as const] : []));
  const parts = joined(kept.map(([, part]) => part));
  return {
    value: Object.fromEntries(kept.map(([key, part]) => [key, part.value])) as T,
    dropped: [...taken.flatMap(([, field]) => (field.is === "absent" ? field.dropped : [])), ...parts.dropped],
    unread: [...unread, ...parts.unread],
  };
}

// An object whose fields hold together, each read by its declaration: one required missing, or one sent refused,
// refuses the whole, as a match without its count or a window without its session is none.
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
  <T extends object>(readers: Readers<T>, fallback: T): Reader<T> =>
  (json, at) => {
    const result = attempt(() =>
      readFields(json, readers, at, (key, missed): Field<T[keyof T]> => {
        const dropped = missed.is === "missing" ? [] : [{ at: [...at, key], why: missed.why }];
        return Object.hasOwn(fallback, key) ? { is: "read", read: { ...read(fallback[key]), dropped } } : { is: "absent", dropped };
      }),
    );
    return "refused" in result ? { ...read(fallback), dropped: [{ at, why: result.refused }] } : result;
  };

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const results = Object.entries(fieldsOf(json, at).value).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]))] as const);
    const kept = results.flatMap(([key, result]) => ("refused" in result ? [] : [[key, result] as const]));
    const parts = joined(kept.map(([, part]) => part));
    return {
      value: Object.fromEntries(kept.map(([key, part]) => [key, part.value])),
      dropped: [...results.flatMap(([key, result]) => ("refused" in result ? [{ at: [...at, key], why: result.refused }] : [])), ...parts.dropped],
      unread: parts.unread,
    };
  };

// A list whose items hold together, each read by `reader` at its index: one refused refuses the whole.
export const list =
  <T>(reader: Reader<T>): Reader<T[]> =>
  (json, at) => {
    if (!Array.isArray(json)) throw new Malformed("is not a list");
    const items = json.map((item: unknown, index) => {
      const result = attempt(() => reader(item, [...at, String(index)]));
      if ("refused" in result) throw new Malformed(`${index}: ${result.refused}`);
      return result;
    });
    return { value: items.map((item) => item.value), ...joined(items) };
  };

// The declarations of a union's variants told apart by the field `tag`, each of its other fields.
export type Variants<K extends string, T extends Record<K, string>> = { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> };

// [LAW:single-enforcer] One of a union told apart by its field `tag`: the variant its tag names, an `object` of its other
// fields; the one place a tag is refused, at `tag`, naming the tags there are. A union that shows what it has no variant
// for (the formatter's block of a type it does not know) reads that by `otherwise`, given the whole object.
export const tagged =
  <K extends string, T extends Record<K, string>, F = never>(tag: K, variants: Variants<K, T>, otherwise?: Reader<F>): Reader<T | F> =>
  (json, at) => {
    const named = kinds.among(Object.keys(variants) as T[K][]);
    const { [tag]: is, ...fields } = fieldsOf(json, at).value;
    if (!named.fits(is)) {
      if (otherwise === undefined) throw new Malformed(`${tag}: is not ${named.expected}`);
      return otherwise(json, at);
    }
    const variant = object(variants[is])(fields, at);
    return { ...variant, value: { ...variant.value, [tag]: is } as unknown as T };
  };

// `reader`'s read of the document `what`, or `Malformed` naming `what`.
function readDocument<T>(reader: Reader<T>, json: unknown, what: string): Read<T> {
  try {
    return reader(json, []);
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(`${what}: ${describe(error)}`) : error;
  }
}

// [LAW:one-source-of-truth] What a field no declaration names is, in a refusal and in what a stored item drops alike.
const unreadWhy = ({ reads }: Unread) => `is not read by this build, which reads ${reads.length === 0 ? "no field here" : reads.join(", ")}`;

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A field it does not read is another build's, and is passed over.
export function parse<T>(reader: Reader<T>, json: unknown, what: string): T {
  return readDocument(reader, json, what).value;
}

// [LAW:single-enforcer] A settings file `what` read whole by `reader`: a field it does not read, at any depth, is
// refused, naming it, since in a file a person wrote it is most often a setting misspelled.
export function parseExact<T>(reader: Reader<T>, json: unknown, what: string): T {
  const { value, unread } = readDocument(reader, json, what);
  const [first] = unread;
  if (first !== undefined) throw new Malformed(`${what}: ${[...first.at, unreadWhy(first)].join(": ")}`);
  return value;
}

// [LAW:single-enforcer] What a stored item's read dropped: each part a tolerant read dropped, and each field no
// declaration names, which writing the item again would lose.
export const droppedOf = ({ dropped, unread }: Read<unknown>): Dropped[] => [...dropped, ...unread.map((field) => ({ at: field.at, why: unreadWhy(field) }))];

// [LAW:single-enforcer] Messages API traffic read by `reader` for the formatter: the read, whose unread fields the
// formatter shows as they were sent, or why it was refused, which it shows beside the value as it was received.
export function readShown<T>(reader: Reader<T>, json: unknown): Read<T> | { refused: string } {
  return attempt(() => reader(json, []));
}

// The object `what` is, or `Malformed` naming it.
export const jsonObject = (json: unknown, what: string): Record<string, unknown> => parse(fieldsOf, json, what);
