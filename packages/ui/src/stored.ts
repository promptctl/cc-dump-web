import type { Ending } from "@cc-dump/log/ending";
import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import { Malformed } from "@cc-dump/log/failure";
import { entries, kinds, object, optional, parseJson, raw, value, type Path, type Read, type Refusal } from "@cc-dump/log/json";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { equal } from "./format/equal.ts";
import { decided, failed } from "./log.ts";

// The items the UI keeps in a Web Storage: the tab's view (view/state.ts) and the reader's settings (settings.ts).
export type StoreName = "cc-dump.view" | "cc-dump.settings";

// [LAW:nothing-unseen] How an item was read: nothing was stored; it was read, under the version it was stored by, with
// each value of it this build refused, which the store holds its first state's for, each field of it no reader of
// this build names, by path, and the versions whose states are kept beside it, unread; what is stored is not an item (not JSON, or not `{state, version}`), so it
// is replaced at the next write; the storage failed as it was reached, so what it holds is not known; or this build's
// own read threw, its bug, so what it holds is not known either.
export type StoredRead =
  | { stored: "none" }
  | { stored: "read"; version: number; refused: readonly Refusal[]; unknown: readonly Path[]; kept: readonly number[] }
  | { stored: "unreadable"; error: Malformed }
  | { stored: "failed"; error: unknown }
  | { stored: "threw"; error: unknown };

// [LAW:single-enforcer] Whether a read reached what is stored, so that what it holds is known: the one answer to it.
function reached(read: StoredRead): boolean {
  switch (read.stored) {
    case "none":
    case "read":
    case "unreadable":
      return true;
    case "failed":
    case "threw":
      return false;
  }
}

// What the UI's storage reports, each on a span ended as it happened: each read of an item; and a run of writes the
// storage refused, as it begins and, on the same span, as it ends.
export type StoredEvent = { store: StoreName; span: Span } & ({ is: "read"; read: StoredRead } | { is: "write_refused"; error: unknown } | { is: "writes_resumed" });
export type Report = (event: StoredEvent) => void;

// [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling] Where the storage's events go, owned here: held
// until the composition root says where, once (`reportStored`), then sent there. A store reads its item as its module
// loads, before the page's log exists, so its first read is held, not lost, in whatever order the modules load.
type Reporting = { to: "held"; events: StoredEvent[] } | { to: "report"; report: Report };
let reporting: Reporting = { to: "held", events: [] };
const emit = (event: StoredEvent) => (reporting.to === "held" ? reporting.events.push(event) : reporting.report(event));

export function reportStored(report: Report): void {
  if (reporting.to === "report") throw new Error("the storage's events already go to a report: one composition root says where");
  const { events } = reporting;
  reporting = { to: "report", report };
  events.forEach(report);
}

// [LAW:nothing-unseen] `span` ended now, for an event reported later (a read held until the page's log exists), so it
// keeps the times it was measured at.
function ended(span: Span): Span {
  const times = span.end();
  return { trace_id: span.trace_id, end: () => times };
}

// An item as one store keeps it: its name, the version this build stores it under, the storage it is kept in, the
// store's first state, and how a stored state is read, by the version it was stored under.
export type Item<T> = { name: StoreName; version: number; storage: () => Storage; initial: T; read: (state: unknown, version: number) => Read<T> };

// [LAW:single-enforcer] [LAW:one-source-of-truth] An item's options for zustand `persist`, which owns the item from
// here: it reads it as the store is made, and again as `rehydrate` asks, through the raw set, which writes nothing, and
// writes the reader's changes to it as they change the store (`written`). The item is stored as persist stores it,
// `{state, version}`, so an item any build stored is read by this read. Every stored version is read here, so the
// state persist is given is always of this one's, and it never migrates.
export function stored<T>(item: Item<T>): { name: StoreName; version: number; storage: PersistStorage<T> } {
  const { name, version, storage } = item;
  // [LAW:no-ambient-temporal-coupling] The item's two facts, independent, each the one owner of what it gates. Whether
  // the last read reached what is stored: until one has, a write would put the store's state over an item nobody read,
  // so none is made, as that read's event says. And the run of writes the storage is refusing, on the span it began
  // on, which only a write the storage takes ends.
  let known = false;
  let refusing: Span | undefined;
  // [LAW:one-source-of-truth] What is stored, as the last read or write left it: what the next write changes.
  let last: Stored<T> = { envelope: {}, state: item.initial, version, read: item.initial };
  const write = (call: (storage: Storage) => void) => {
    if (!known) return;
    const written = reach(storage, call);
    if ("error" in written && refusing === undefined) {
      refusing = startTrace();
      emit({ store: name, span: ended(refusing), is: "write_refused", error: written.error });
    }
    if (!("error" in written) && refusing !== undefined) {
      emit({ store: name, span: ended(refusing), is: "writes_resumed" });
      refusing = undefined;
    }
  };
  return {
    name,
    version,
    storage: {
      getItem: () => {
        const span = startTrace();
        const { read, state, stored } = readItem(item);
        emit({ store: name, span: ended(span), is: "read", read });
        known = reached(read);
        last = stored ?? last;
        return state;
      },
      setItem: (_, { state }) => {
        const next = written(last, state, version);
        const text = JSON.stringify(next.envelope);
        write((storage) => {
          storage.setItem(name, text);
          last = next;
        });
      },
      removeItem: () => write((kept) => kept.removeItem(name)),
    },
  };
}

// [LAW:effects-at-boundaries] A call of the storage, or what it threw. Only the storage's own calls are inside: in a
// sandboxed frame the browser throws as the storage is reached, and a full one throws as it is written.
function reach<R>(storage: () => Storage, call: (storage: Storage) => R): { ok: R } | { error: unknown } {
  try {
    return { ok: call(storage()) };
  } catch (error) {
    return { error };
  }
}

// [LAW:parse-dont-validate] The item stored under `name`, read: how, and the state it gives persist. Nothing stored,
// and what is no item, give the store's first state, so a page start and a read again read one item alike. A read that
// did not reach what is stored gives none, and the state the store holds stays.
function readItem<T>({ name, version, storage, initial, read }: Item<T>): { read: StoredRead; state: StorageValue<T> | null; stored?: Stored<T> } {
  const text = reach(storage, (kept) => kept.getItem(name));
  if ("error" in text) return { read: { stored: "failed", error: text.error }, state: null };
  const none: Stored<T> = { envelope: {}, state: initial, version, read: initial };
  if (text.ok === null) return { read: { stored: "none" }, state: { state: initial, version }, stored: none };
  try {
    const json = parseJson(text.ok, name);
    const envelope = envelopeOf(json);
    const state = read(envelope.value.state, envelope.value.version);
    const refused = state.replaced.map(({ at, why }) => ({ at: ["state", ...at], why }));
    const unknown = [...envelope.unknown.map(({ at }) => at), ...state.unknown.map(({ at }) => ["state", ...at])];
    const kept = Object.keys(envelope.value.kept ?? {}).map(Number);
    return {
      read: { stored: "read", version: envelope.value.version, refused, unknown, kept },
      state: { state: state.value, version },
      stored: { envelope: json as Envelope, state: envelope.value.state, version: envelope.value.version, read: state.value },
    };
  } catch (error) {
    // [LAW:no-silent-failure] persist swallows what `getItem` throws, so this build's own bug is reported here.
    return error instanceof Malformed ? { read: { stored: "unreadable", error }, state: { state: initial, version }, stored: none } : { read: { stored: "threw", error }, state: null };
  }
}

// An item as it is stored: persist's `{state, version}`, and, kept beside them, the state each other version of the
// item stored, by its version, which this build never reads as its own. A build that does not know `kept` passes
// it over, as a field its envelope has no reader for.
type Envelope = { state?: unknown; version?: number; kept?: Record<string, unknown> } & Record<string, unknown>;
const envelope = object<{ state: unknown; version: number; kept: Record<string, unknown> | undefined }>({ state: raw, version: value(kinds.integer), kept: optional(entries(raw)) });
const envelopeOf = (json: unknown) => envelope(json, []);

// What is stored, as a read or a write left it: the envelope as it is stored, the state in it and the version that
// stored it, and that state as this build read it, which the store was given.
type Stored<T> = { envelope: Envelope; state: unknown; version: number; read: T };

// [LAW:one-source-of-truth] What a write of `state` stores: only the reader's changes, those of `state` from the state
// as read, over the item as it is stored, so a field this build has no reader for, and a value it refused (whose
// fallback the store holds), stay as stored until the reader changes them. A state another version stored is kept
// as it is under its version, and the item's state is this build's read of it with the reader's changes, so a value
// stored under another version is never written as this version's.
function written<T>(stored: Stored<T>, state: T, version: number): Stored<T> {
  const base = stored.version === version ? stored.state : stored.read;
  const kept = stored.version === version ? stored.envelope.kept : { ...stored.envelope.kept, [String(stored.version)]: stored.state };
  const next = patch(base, state, diff(state, stored.read, []));
  return { envelope: { ...stored.envelope, state: next, version, ...(kept === undefined ? {} : { kept }) }, state: next, version, read: state };
}

const isObject = (json: unknown): json is Record<string, unknown> => typeof json === "object" && json !== null && !Array.isArray(json);

// The paths at which `now` differs from `was`: an object's fields, each compared at its own path, and any other value
// whole, so a change is as deep as the reader made it.
function diff(now: unknown, was: unknown, at: Path): Path[] {
  if (!isObject(now) || !isObject(was)) return equal(now, was) ? [] : [at];
  const keys = new Set([...Object.keys(now), ...Object.keys(was)]);
  return [...keys].flatMap((key) => diff(Object.hasOwn(now, key) ? now[key] : undefined, Object.hasOwn(was, key) ? was[key] : undefined, [...at, key]));
}

// `base` with the value `now` holds at each of `changes`: a field `now` has not, removed. Where `base` holds no object
// for a change to go into, `now`'s value there replaces it whole. Objects are built with `Object.fromEntries`, so a
// field named `__proto__` is a field.
function patch(base: unknown, now: unknown, changes: readonly Path[]): unknown {
  return changes.reduce((into, change) => put(into, now, change), base);
}

function put(base: unknown, now: unknown, [key, ...rest]: Path): unknown {
  if (key === undefined || !isObject(base) || !isObject(now)) return now;
  const fields = Object.entries(base);
  if (!Object.hasOwn(now, key) || now[key] === undefined) return Object.fromEntries(fields.filter(([name]) => name !== key));
  const field = put(Object.hasOwn(base, key) ? base[key] : undefined, now[key], rest);
  return Object.fromEntries(Object.hasOwn(base, key) ? fields.map(([name, kept]) => [name, name === key ? field : kept]) : [...fields, [key, field]]);
}

// Whether a change another tab made to a storage (a `StorageEvent`) is to `item`: in its storage, at its name, or a
// clear of the whole storage.
export const changes = ({ name, storage }: Item<unknown>, { storageArea, key }: Pick<StorageEvent, "storageArea" | "key">): boolean =>
  storageArea === storage() && (key === null || key === name);

// [LAW:nothing-unseen] The storage's events written to `log`: `stored_read`, at each read of an item, which says how it
// was read (`stored`) and names each value refused and each field unknown, or the failure, and whether writes are made after it (`writes`); `stored_write_refused`, as a run of writes the storage refuses (a full quota) begins; and
// `stored_writes_resumed`, as it ends, on its span, so its duration is the run's.
export const storedLog =
  (log: Log): Report =>
  (event) => {
    const [name, facts, ending] = described(event);
    decided(log, name, { store: event.store, ...facts }, ending, event.span);
  };

function described(event: StoredEvent): [string, Facts, Ending] {
  switch (event.is) {
    case "read":
      return readFacts(event.read);
    case "write_refused":
      return ["stored_write_refused", {}, failed(event.error)];
    case "writes_resumed":
      return ["stored_writes_resumed", {}, { outcome: "ok" }];
  }
}

// A read's event: how it was read, and whether writes are made after it, as `reached` says.
function readFacts(read: StoredRead): [string, Facts, Ending] {
  const [facts, ending] = readOutcome(read);
  return ["stored_read", { stored: read.stored, ...facts, writes: reached(read) ? "made" : "skipped" }, ending];
}

function readOutcome(read: StoredRead): [Facts, Ending] {
  switch (read.stored) {
    case "none":
      return [{ refused: [], unknown: [], kept: [] }, { outcome: "ok" }];
    case "read":
      return [{ version: read.version, refused: read.refused, unknown: read.unknown, kept: read.kept }, { outcome: "ok" }];
    case "unreadable":
    case "failed":
    case "threw":
      return [{}, failed(read.error)];
  }
}
