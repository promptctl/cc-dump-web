// [LAW:single-enforcer] The one reader family for the JSON documents the app receives: the parts' messages (each
// part's format.ts), log lines (line.ts), settings files (@cc-dump/config) and the UI's stored items. An object is read
// field by field, once, and the read says what each field became: read, refused by its path, or named by no reader.
// What a field no reader names means is the document's to decide, by the entry point it is read through. Imports
// nothing that needs node, so the formats a part shares with the UI use it too.
import { describe } from "./describe.ts";
import { Malformed } from "./failure.ts";

// What JSON text can say: what `JSON.stringify` encodes, and `JSON.parse` gives back, as it was.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

// [LAW:single-enforcer] The one `JSON.parse`: the value JSON text says, or `Malformed`.
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Malformed("is not JSON", { cause: error });
  }
}

const isObject = (json: unknown): json is Record<string, unknown> => typeof json === "object" && json !== null && !Array.isArray(json);

const objectOf = (json: unknown): Readonly<Record<string, unknown>> => {
  if (!isObject(json)) throw new Malformed("is not an object");
  return json;
};

// A JSON type a value must have: its test, and its name in an error.
export type Kind<T> = { fits: (value: unknown) => value is T; expected: string };

// [LAW:single-enforcer] The kinds every read below takes, so each names a value's type alike.
export const kinds = {
  string: { fits: (value): value is string => typeof value === "string", expected: "a string" } as Kind<string>,
  boolean: { fits: (value): value is boolean => typeof value === "boolean", expected: "a boolean" } as Kind<boolean>,
  integer: { fits: Number.isSafeInteger as (value: unknown) => value is number, expected: "an integer" } as Kind<number>,
  number: { fits: Number.isFinite as (value: unknown) => value is number, expected: "a number" } as Kind<number>,
  among: <T extends string>(values: readonly T[]): Kind<T> => ({
    fits: (value): value is T => typeof value === "string" && (values as readonly string[]).includes(value),
    expected: `one of ${values.join(", ")}`,
  }),
};

// Where in a JSON value a part of it is: the field names and entry keys from its root. A list, not a dotted string,
// since a key may hold a dot or a slash (a row's key does).
export type Path = readonly string[];

// [LAW:types-are-the-program] A field an object's read did not take, at `at`: it is not there, or its reader refused it,
// and why.
export type Refusal = { readonly at: Path } & ({ readonly is: "missing" } | { readonly is: "refused"; readonly why: string });

// A field no declaration names: the path of the object holding it, its key, its value as sent, and the keys that
// object's declaration reads.
export type Unread = { readonly of: Path; readonly key: string; readonly value: unknown; readonly reads: readonly string[] };

// A part of a value this build did not take, at `at`, and why.
export type Dropped = { readonly at: Path; readonly why: string };

// [LAW:parse-dont-validate] A value read as this build reads it, with each part of it that was dropped and each field
// no declaration names, at every depth a reader passed them up from.
export type Read<T> = { readonly value: T; readonly dropped: readonly Dropped[]; readonly unread: readonly Unread[] };

// A read of the value at `at`: it is read, or refused whole with `Malformed`, in words that do not repeat `at`. Any
// other error is the reader's own bug, and passes as it is.
export type Reader<T> = (json: unknown, at: Path) => Read<T>;

// A reader of a field an object may leave out.
export type Optional<T> = Reader<T> & { readonly optional: true };

// [LAW:types-are-the-program] A reader for each field of `T`: an optional one exactly for each field `T` may leave out.
export type Readers<T> = { readonly [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? Optional<Exclude<T[K], undefined>> : Reader<T[K]> & { readonly optional?: never } };

// An object read field by field: the object as sent, each field that read, each refused by its path, and each no
// declaration names. `sent` is there only to show the object as it was sent; nothing reads a field from it.
export type Fields<T> = { readonly sent: Readonly<Record<string, unknown>>; readonly value: Partial<T>; readonly refused: readonly Refusal[]; readonly unread: readonly Unread[] };

// The readers of each variant of a union told apart by a tag, by its tag.
export type Variants<V> = { readonly [Tag in keyof V & string]: Readers<V[Tag]> };

// [LAW:types-are-the-program] The variant a tag names, its fields read by that variant's readers, so the tag and the
// fields' type are one fact.
export type Tagged<V> = { [Tag in keyof V & string]: { readonly is: "known"; readonly tag: Tag; readonly fields: Fields<V[Tag]> } }[keyof V & string];

// A tag no variant has, and the object read as another build's.
export type Other<O> = { readonly is: "other"; readonly tag: string; readonly other: O };

// A value read, or refused with why and as it was sent, so it can be shown either way.
export type Shown<T> = { readonly is: "read"; readonly read: Read<T> } | { readonly is: "refused"; readonly why: string; readonly sent: unknown };

// A value read whole, with each field no declaration names, named.
export type Reported<T> = { readonly value: T; readonly unread: readonly Dropped[] };

// [LAW:types-are-the-program] What `read` gives, or why it refused: only `Malformed` is a refusal.
type Attempt<R> = { readonly is: "read"; readonly read: R } | { readonly is: "refused"; readonly why: string };
function attempt<R>(read: () => R): Attempt<R> {
  try {
    return { is: "read", read: read() };
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { is: "refused", why: describe(error) };
  }
}

// [LAW:single-enforcer] The one wording of a part not taken: its path, then why.
export const words = ({ at, why }: Dropped): string => [...at, why].join(": ");

const reason = (refusal: Refusal): string => (refusal.is === "missing" ? "is missing" : refusal.why);

// The refusals of the object at `at`, each by its path from it.
export const refusalOf = (refused: readonly Refusal[], at: Path): string =>
  refused.map((refusal) => words({ at: refusal.at.slice(at.length), why: reason(refusal) })).join("; ");

// A field no declaration names, named, with the keys its object's declaration reads.
export const notRead = ({ of, key, reads }: Unread): Dropped => ({ at: [...of, key], why: `is not read by this build, which reads ${reads.length === 0 ? "no field" : reads.join(", ")}` });

const leaf = <T>(value: T): Read<T> => ({ value, dropped: [], unread: [] });

// A value of `kind`, as it is.
export const value =
  <K>(kind: Kind<K>): Reader<K> =>
  (json) => {
    if (!kind.fits(json)) throw new Malformed(`is not ${kind.expected}`);
    return leaf(json);
  };

// [LAW:types-are-the-program] A value `reader` reads, as `parse` takes it, or refused in the parser's words.
export const refined =
  <K, T>(reader: Reader<K>, parse: (value: K) => T): Reader<T> =>
  (json, at) => {
    const read = reader(json, at);
    return { ...read, value: parse(read.value) };
  };

// A value of `kind`, as `parse` takes it.
export const parsed = <K, T>(kind: Kind<K>, parse: (value: K) => T): Reader<T> => refined(value(kind), parse);

// A value that is `null`, or one `reader` reads.
export const nullable =
  <T>(reader: Reader<T>): Reader<T | null> =>
  (json, at) =>
    json === null ? leaf(null) : reader(json, at);

// A value taken as it is, for a part read on its own later (a stored item's state, by its version).
export const raw: Reader<unknown> = leaf;

// A field `reader` reads, which its object may leave out.
export const optional = <T>(reader: Reader<T>): Optional<T> => Object.assign((json: unknown, at: Path) => reader(json, at), { optional: true as const });

// A list of values each `item` reads, by its index: one refused refuses the list.
export const list =
  <T>(item: Reader<T>): Reader<readonly T[]> =>
  (json, at) => {
    if (!Array.isArray(json)) throw new Malformed("is not a list");
    const reads = json.map((entry: unknown, index) => {
      const read = attempt(() => item(entry, [...at, String(index)]));
      if (read.is === "refused") throw new Malformed(words({ at: [String(index)], why: read.why }));
      return read.read;
    });
    return { value: reads.map(({ value }) => value), dropped: reads.flatMap(({ dropped }) => dropped), unread: reads.flatMap(({ unread }) => unread) };
  };

// [LAW:single-enforcer] A value that holds its own refusal: never refused, it is what `reader` read, or why not and
// what was sent, so a part that does not read costs only itself. It is the root of the paths it names, since what it
// holds is said of itself.
export const held =
  <T>(reader: Reader<T>): Reader<Shown<T>> =>
  (json) => {
    const read = attempt(() => reader(json, []));
    return leaf(read.is === "read" ? read : { ...read, sent: json });
  };

// A value sent as JSON text, read by `reader`.
export const fromJsonText =
  <T>(reader: Reader<T>): Reader<T> =>
  (json, at) =>
    reader(jsonOf(value(kinds.string)(json, at).value), at);

// The readers of an object's fields, as the read below takes them, whatever type they read.
type Declared = Readonly<Record<string, Reader<unknown> & { readonly optional?: true }>>;

// [LAW:single-enforcer] The one object read. Each declared field is read at its path, or refused, or, absent, skipped
// when it is optional and missing when not. Each own key no declaration names, `tags` (a union's tag) aside, is named
// by its object's path, this object's own in sent order before those its fields passed up. The value is built by
// `Object.fromEntries`, so a key like `__proto__` is an own key like any other.
function readFields(readers: Declared, json: unknown, at: Path, tags: readonly string[]): Read<Fields<Record<string, unknown>>> {
  const sent = objectOf(json);
  const reads = [...tags, ...Object.keys(readers)];
  const outcomes = Object.entries(readers).flatMap(([key, reader]): ({ key: string; read: Read<unknown> } | Refusal)[] => {
    const field = [...at, key];
    if (!Object.hasOwn(sent, key)) return reader.optional ? [] : [{ at: field, is: "missing" }];
    const read = attempt(() => reader(sent[key], field));
    return [read.is === "read" ? { key, read: read.read } : { at: field, is: "refused", why: read.why }];
  });
  const taken = outcomes.flatMap((outcome) => ("is" in outcome ? [] : [outcome]));
  return {
    value: {
      sent,
      value: Object.fromEntries(taken.map(({ key, read }) => [key, read.value])),
      refused: outcomes.flatMap((outcome) => ("is" in outcome ? [outcome] : [])),
      unread: [...Object.keys(sent).flatMap((key) => (reads.includes(key) ? [] : [{ of: at, key, value: sent[key], reads }])), ...taken.flatMap(({ read }) => read.unread)],
    },
    dropped: taken.flatMap(({ read }) => read.dropped),
    unread: [],
  };
}

// [LAW:types-are-the-program] An object read field by field by its readers, holding its own refusals and unread fields.
export const fields =
  <T>(readers: Readers<T>): Reader<Fields<T>> =>
  (json, at) =>
    // each value was read by the reader declared for its key
    readFields(readers as unknown as Declared, json, at, []) as unknown as Read<Fields<T>>;

// The object a read is, or `Malformed` naming each field refused.
export function whole<T>(read: Fields<T>, at: Path): T {
  if (read.refused.length > 0) throw new Malformed(refusalOf(read.refused, at));
  // [LAW:types-are-the-program] no refusal: every required key read
  return read.value as T;
}

// An object whose fields hold together, each read by its reader: one missing or refused refuses the whole, as a
// match without its count or a window without its session is none.
export const object = <T>(readers: Readers<T>): Reader<T> => {
  const read = fields(readers);
  return (json, at) => {
    const { value, dropped } = read(json, at);
    return { value: whole(value, at), dropped, unread: value.unread };
  };
};

// [LAW:parse-dont-validate] A tolerant reader: an object whose fields are each an independent choice, each read on its
// own, one missing taken as `fallback`'s, naming nothing, so a field added to this build is not reported on its first
// read, and one refused as `fallback`'s and dropped, so every other is kept. Never refused: what is not an object is
// `fallback`, dropped.
export const tolerant = <T>(readers: Readers<T>, fallback: T): Reader<T> => {
  const read = fields(readers);
  return (json, at) => {
    const tried = attempt(() => read(json, at));
    if (tried.is === "refused") return { value: fallback, dropped: [{ at, why: tried.why }], unread: [] };
    const { value, refused, unread } = tried.read.value;
    const dropped = refused.flatMap((refusal) => (refusal.is === "refused" ? [{ at: refusal.at, why: refusal.why }] : []));
    return { value: { ...fallback, ...value }, dropped: [...dropped, ...tried.read.dropped], unread };
  };
};

// A map whose entries are each an independent choice, each read by `reader`: one refused is dropped alone.
export const entries =
  <T>(reader: Reader<T>): Reader<Record<string, T>> =>
  (json, at) => {
    const reads = Object.entries(objectOf(json)).map(([key, entry]) => [key, attempt(() => reader(entry, [...at, key]))] as const);
    const taken = reads.flatMap(([key, read]) => (read.is === "read" ? [[key, read.read] as const] : []));
    return {
      value: Object.fromEntries(taken.map(([key, { value }]) => [key, value])),
      dropped: reads.flatMap(([key, read]) => (read.is === "read" ? read.read.dropped : [{ at: [...at, key], why: read.why }])),
      unread: taken.flatMap(([, { unread }]) => unread),
    };
  };

// A union with no reader for another build's variants: a tag it has no variant for is refused.
const notOneOf =
  (key: string, variants: object): Reader<never> =>
  () => {
    throw new Malformed(words({ at: [key], why: `is not one of ${Object.keys(variants).join(", ")}` }));
  };

// [LAW:single-enforcer] One of a union told apart by its field `key`: the variant its tag names, its other fields read
// field by field, or, for a tag no variant has, the object as `otherwise` reads it. A tag is looked up as an own key,
// so `constructor` or `__proto__` is a tag like any other.
export function union<K extends string, V>(key: K, variants: Variants<V>): Reader<Tagged<V>>;
export function union<K extends string, V, O>(key: K, variants: Variants<V>, otherwise: Reader<O>): Reader<Tagged<V> | Other<O>>;
export function union<K extends string, V, O>(key: K, variants: Variants<V>, otherwise: Reader<O> = notOneOf(key, variants)): Reader<Tagged<V> | Other<O>> {
  return (json, at) => {
    const sent = objectOf(json);
    if (!Object.hasOwn(sent, key)) throw new Malformed(words({ at: [key], why: "is missing" }));
    const tag = sent[key];
    if (!kinds.string.fits(tag)) throw new Malformed(words({ at: [key], why: `is not ${kinds.string.expected}` }));
    if (!Object.hasOwn(variants, tag)) {
      const read = otherwise(json, at);
      return { ...read, value: { is: "other", tag, other: read.value } };
    }
    const read = readFields((variants as unknown as Readonly<Record<string, Declared>>)[tag]!, sent, at, [key]);
    // [LAW:types-are-the-program] the fields were read by the readers of the variant `tag` names
    return { value: { is: "known", tag, fields: read.value } as unknown as Tagged<V>, dropped: read.dropped, unread: [] };
  };
}

// One of a union told apart by its field `tag`, read whole: the variant its tag names, an `object` of its other fields.
export const tagged = <K extends string, T extends Record<K, string>>(tag: K, variants: { [V in T[K]]: Readers<Omit<Extract<T, Record<K, V>>, K>> }): Reader<T> => {
  const read = union(tag, variants as unknown as Variants<Record<string, Record<string, unknown>>>);
  return (json, at) => {
    const { value, dropped } = read(json, at);
    return { value: { ...whole(value.fields, at), [tag]: value.tag } as unknown as T, dropped, unread: value.fields.unread };
  };
};

// A message `what` read whole by `reader`: what it dropped is refused with what it refused.
function readWhole<T>(reader: Reader<T>, json: unknown, what: string): Read<T> {
  const read = attempt(() => {
    const read = reader(json, []);
    if (read.dropped.length > 0) throw new Malformed(read.dropped.map(words).join("; "));
    return read;
  });
  if (read.is === "refused") throw new Malformed(`${what}: ${read.why}`);
  return read.read;
}

// [LAW:single-enforcer] A message `what` read whole by `reader`, or refused with `Malformed` naming `what`: the one way
// a part reads a JSON message. A field it does not read is another build's, and is passed over.
export const parse = <T>(reader: Reader<T>, json: unknown, what: string): T => readWhole(reader, json, what).value;

// A document `what` read whole by `reader`, refused as `parse` refuses, with each field it does not read named.
export function parseReported<T>(reader: Reader<T>, json: unknown, what: string): Reported<T> {
  const read = readWhole(reader, json, what);
  return { value: read.value, unread: read.unread.map(notRead) };
}

// Each part a read did not take: each field no declaration names, and each dropped.
export const droppedOf = (read: Read<unknown>): Dropped[] => [...read.unread.map(notRead), ...read.dropped];

// A value read by `reader`, or why not and as it was sent.
export const readShown = <T>(reader: Reader<T>, json: unknown): Shown<T> => held(reader)(json, []).value;

// The value JSON text `text` says, or `Malformed` naming `what`.
export const parseJson = (text: string, what: string): unknown => parse(fromJsonText(raw), text, what);
