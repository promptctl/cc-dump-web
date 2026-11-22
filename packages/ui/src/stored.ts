import { Malformed } from "@cc-dump/log/failure";
import { startTrace, type Log } from "@cc-dump/log/event";
import { jsonObject, parseJson } from "@cc-dump/log/json";
import type { StoreApi } from "zustand";
import { failed, unitOfWork } from "./log.ts";

// [LAW:one-source-of-truth] [LAW:single-enforcer] An item kept in a Web Storage, by its one owner: the name it is kept
// under, the value a reader has before choosing anything, what it says as read by this build, and what is written for
// it. The read and the write of an item are in one place, so its stored format has one owner.
export type Item<T> = { name: string; fallback: T; parse: (json: unknown, dropped: Dropped) => T; write: (value: T) => unknown };

// Each field of a stored value this build could not read, by its path, with why: it is read as the fallback's.
export type Dropped = Record<string, string>;

// [LAW:nothing-unseen] How an item was read: the browser keeps no storage here (`unavailable`, as under node in the
// tests), nothing was stored, it was read with what was dropped of it, or the storage failed as it was read.
export type Read = { stored: "unavailable" } | { stored: "none" } | { stored: "read"; dropped: Dropped } | { stored: "failed"; error: unknown };

export type Restored<T> = { value: T; read: Read };

// [LAW:parse-dont-validate] An item as stored, read as this build reads it: the value, each field the one stored or,
// where what is stored is not a value this build reads, the fallback's, named in the read. A storage that fails is the
// read's outcome, never thrown, so a page whose storage the browser blocks opens as a new one, and says so. `storage` is
// reached inside the read, since in a sandboxed frame the browser throws as the storage itself is reached.
export function readStored<T>(storage: () => Storage | undefined, item: Item<T>): Restored<T> {
  let reached: Storage | undefined;
  let text: string | null;
  try {
    reached = storage();
    text = reached === undefined ? null : reached.getItem(item.name);
  } catch (error) {
    return { value: item.fallback, read: { stored: "failed", error } };
  }
  if (reached === undefined) return { value: item.fallback, read: { stored: "unavailable" } };
  if (text === null) return { value: item.fallback, read: { stored: "none" } };
  const dropped: Dropped = {};
  return { value: dropping(item.name, item.fallback, dropped, () => item.parse(parseJson(text, item.name), dropped)), read: { stored: "read", dropped } };
}

// [LAW:effects-at-boundaries] The item kept as `store` changes, wired by the composition root, which reports a write
// the storage refuses (a full quota) as `refused`.
export function keepStored<T>(store: StoreApi<T>, storage: () => Storage, item: Item<T>, refused: (error: unknown) => void): () => void {
  return store.subscribe((value) => {
    try {
      storage().setItem(item.name, JSON.stringify(item.write(value)));
    } catch (error) {
      refused(error);
    }
  });
}

// A field of a stored value: a value read by a parser, which throws `Malformed` for one it cannot take; an object of
// fields, each read on its own; or a map whose entries are each an independent choice, each read on its own.
export type Field<T> = Reader<T> | { fields: Fields<T> } | { entries: Reader<T[keyof T]> };
export type Reader<T> = (value: unknown, what: string) => T;
export type Fields<T> = { [K in keyof T]-?: Field<T[K]> };

// The readers of a value of JSON's own types, and of one of `values`.
export const text: Reader<string> = (value, what) => {
  if (typeof value !== "string") throw new Malformed(`${what}: is not a string`);
  return value;
};
export const boolean: Reader<boolean> = (value, what) => {
  if (typeof value !== "boolean") throw new Malformed(`${what}: is not a boolean`);
  return value;
};
export const member =
  <T,>(values: readonly T[]): Reader<T> =>
  (value, what) => {
    if (!(values as readonly unknown[]).includes(value)) throw new Malformed(`${what}: is not one of ${values.join(", ")}`);
    return value as T;
  };

// [LAW:parse-dont-validate] `json` read as `field` reads it, each part it cannot read the fallback's and named in
// `dropped`, by its path from `what`: an object that is not one, a field missing, a value its parser refuses, and a
// field this build does not read, which is gone once the value is written again. An entry of a map that is refused is
// dropped alone, so the map holds no choice for it.
export function keep<T>(field: Field<T>, fallback: T, json: unknown, what: string, dropped: Dropped): T {
  return dropping(what, fallback, dropped, () =>
    typeof field === "function"
      ? field(json, what)
      : "fields" in field
        ? keepFields(field.fields, fallback, jsonObject(json, what), what, dropped)
        : keepEntries(field.entries, jsonObject(json, what), what, dropped),
  );
}

function keepFields<T>(fields: Fields<T>, fallback: T, object: Record<string, unknown>, what: string, dropped: Dropped): T {
  for (const key of Object.keys(object)) if (!Object.hasOwn(fields, key)) dropped[`${what}.${key}`] = "is not read by this build";
  const kept = (Object.entries(fields) as [keyof T & string, Field<T[keyof T]>][]).map(([key, field]) => {
    const at = `${what}.${key}`;
    if (!Object.hasOwn(object, key)) dropped[at] = "is missing";
    return [key, Object.hasOwn(object, key) ? keep(field, fallback[key], object[key], at, dropped) : fallback[key]];
  });
  return Object.fromEntries(kept) as T;
}

function keepEntries<T>(entry: Reader<T[keyof T]>, object: Record<string, unknown>, what: string, dropped: Dropped): T {
  const kept = Object.entries(object).flatMap(([key, value]) => {
    const at = `${what}.${key}`;
    const result = attempt(() => entry(value, at));
    if ("why" in result) dropped[at] = result.why;
    return "why" in result ? [] : [[key, result.kept]];
  });
  return Object.fromEntries(kept) as T;
}

// `read`'s value, or, where it refuses what it reads, `fallback`, with why named in `dropped` at `what`.
function dropping<T>(what: string, fallback: T, dropped: Dropped, read: () => T): T {
  const result = attempt(read);
  if ("why" in result) dropped[what] = result.why;
  return "why" in result ? fallback : result.kept;
}

// [LAW:single-enforcer] What `read` gives, or why it refused: only `Malformed` is a refusal. Any other error is the
// parser's bug, and passes as it is.
function attempt<T>(read: () => T): { kept: T } | { why: string } {
  try {
    return { kept: read() };
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { why: error.message };
  }
}

// [LAW:nothing-unseen] Each read of a stored item is an event, `stored_read`, written every time, so a tab that opens new
// says whether nothing was stored, what was dropped, or that the storage failed; and a write the storage refuses is
// `stored_write_refused`.
export function storedLog(log: Log) {
  return {
    read: (store: string, read: Read) =>
      unitOfWork(log, "stored_read", { store, stored: read.stored, dropped: read.stored === "read" ? read.dropped : {} }, startTrace()).end(
        read.stored === "failed" ? failed(read.error) : { outcome: "ok" },
      ),
    refused: (store: string) => (error: unknown) => unitOfWork(log, "stored_write_refused", { store }, startTrace()).end(failed(error)),
  };
}
