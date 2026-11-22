import type { Ending } from "@cc-dump/log/ending";
import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import { Malformed } from "@cc-dump/log/failure";
import { encoded, entries, held, kinds, object, parseJson, raw, value, type Path, type Read, type Reader, type Refusal } from "@cc-dump/log/json";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { equal } from "./equal.ts";
import { decided, failed } from "./log.ts";

// The items the UI keeps in a Web Storage: the tab's view (view/state.ts) and the reader's settings (settings.ts).
export type StoreName = "cc-dump.view" | "cc-dump.settings";

// [LAW:nothing-unseen] How an item was read: nothing was stored; it was read, under the version the state it read was
// stored by, with each value of it this build refused, which the store holds its first state's for, each field of it
// no reader of this build names, by path, and the versions whose states are kept beside it; what is stored is not an
// item (not JSON, or not the envelope every build shares), so it is replaced at the next write; the storage failed as
// it was reached, so what it holds is not known; or this build's own read threw, its bug, so what it holds is not
// known either.
export type StoredRead =
  | { stored: "none" }
  | { stored: "read"; version: number; refused: readonly Refusal[]; unknown: readonly Path[]; kept: readonly string[] }
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
  // [LAW:one-source-of-truth] The state the store was last given by a read, or last stored: what the reader's changes
  // are changes of. What is stored is read again at each write, never kept here, so a write goes over the item as
  // another tab, or a removal, left it.
  let baseline: T = item.initial;
  // A write of what the item becomes, from what is stored: its text, or none, which removes it. Whether the storage
  // took it. What it becomes is worked out between the storage's calls, so a bug in it passes as it is.
  const store = (text: string | null) => reach(storage, (kept) => (text === null ? kept.removeItem(name) : kept.setItem(name, text)));
  const write = (next: (stored: string | null) => string | null): boolean => {
    if (!known) return false;
    const stored = reach(storage, (kept) => kept.getItem(name));
    const written = "error" in stored ? stored : store(next(stored.ok));
    if ("error" in written && refusing === undefined) {
      refusing = startTrace();
      emit({ store: name, span: ended(refusing), is: "write_refused", error: written.error });
    }
    if (!("error" in written) && refusing !== undefined) {
      emit({ store: name, span: ended(refusing), is: "writes_resumed" });
      refusing = undefined;
    }
    return !("error" in written);
  };
  return {
    name,
    version,
    storage: {
      getItem: () => {
        const span = startTrace();
        const { read, state } = readItem(item);
        emit({ store: name, span: ended(span), is: "read", read });
        known = reached(read);
        baseline = state === null ? baseline : state.state;
        return state;
      },
      setItem: (_, { state }) => {
        if (write((stored) => JSON.stringify(written(item, stored, baseline, state)))) baseline = state;
      },
      removeItem: () => write(() => null),
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
function readItem<T>({ name, version, storage, initial, read }: Item<T>): { read: StoredRead; state: StorageValue<T> | null } {
  const text = reach(storage, (kept) => kept.getItem(name));
  if ("error" in text) return { read: { stored: "failed", error: text.error }, state: null };
  if (text.ok === null) return { read: { stored: "none" }, state: { state: initial, version } };
  try {
    const envelope = storedItem(parseJson(text.ok, name), []);
    const own = ownState(envelope.value, version);
    const state = read(own.state, own.version);
    const refused = state.replaced.map(({ at, why }) => ({ at: [...own.at, ...at], why }));
    const unknown = [...envelope.unknown.map(({ at }) => at), ...state.unknown.map(({ at }) => [...own.at, ...at])];
    return {
      read: { stored: "read", version: own.version, refused, unknown, kept: Object.keys(envelope.value.kept) },
      state: { state: state.value, version },
    };
  } catch (error) {
    // [LAW:no-silent-failure] persist swallows what `getItem` throws, so this build's own bug is reported here.
    return error instanceof Malformed ? { read: { stored: "unreadable", error }, state: { state: initial, version } } : { read: { stored: "threw", error }, state: null };
  }
}

// [LAW:parse-dont-validate] [LAW:one-source-of-truth] An item as it is stored: persist's `{state, version}`, its state
// sent, the state of the version that last wrote it; and `kept` beside them, by version, the state of each other
// version that wrote it before, none when it holds none. Each version's state is in one place, the item's or kept. Its
// fields are the format every build shares, so a `kept` of another shape makes what is stored no item, as a `version`
// of another type does. A build that does not know `kept` passes it over, as a field its envelope has no reader for.
type Envelope = { state: unknown; version: number; kept: Record<string, unknown> };
const keptStates = entries(raw);
const storedItem = object<Envelope>({ state: value(kinds.sent), version: value(kinds.integer), kept: (json, at) => keptStates(json === undefined ? {} : json, at) });
const storedText: Reader<Envelope> = (text, at) => storedItem(encoded(text, at).value, at);

// The state this build reads of an item, at `at` in it: its own version's, the item's or the one kept under its
// version, so a state it stored comes back as it stored it whichever versions wrote the item since; and when the
// item holds none of its version's, the state another version last stored, which it reads as its own.
function ownState({ state, version: by, kept }: Envelope, version: number): { state: unknown; version: number; at: Path } {
  if (by === version) return { state, version, at: ["state"] };
  return Object.hasOwn(kept, String(version)) ? { state: kept[String(version)], version, at: ["kept", String(version)] } : { state, version: by, at: ["state"] };
}

// [LAW:one-source-of-truth] What a write of `state` stores over `stored`, the item as it is stored now: only the
// reader's changes, those of `state` from `baseline`, over the state this build reads of it (ownState), so a field
// this build has no reader for, a value it refused (whose fallback the store holds), and a change another tab made stay
// as stored until the reader changes them. The item's state becomes this version's; the state another version last
// stored is kept under its version, and every state kept stays as it was, but this version's own, which the item now
// holds. An item that is none, or does not read, is replaced. The envelope's other fields are written after it as
// stored.
function written<T>({ version, read }: Item<T>, stored: string | null, baseline: T, state: T): Record<string, unknown> {
  const item = stored === null ? undefined : held(storedText)(stored, []);
  const envelope = item?.value.is === "read" ? item.value.value : { state: baseline, version, kept: {} };
  const others = (item?.unknown ?? []).map(({ at, value }): [string, unknown] => [at[0]!, value]);
  const own = ownState(envelope, version);
  const base = own.version === version ? own.state : read(own.state, own.version).value;
  const keeping = envelope.version === version ? envelope.kept : { ...envelope.kept, [String(envelope.version)]: envelope.state };
  const kept = Object.fromEntries(Object.entries(keeping).filter(([stored]) => stored !== String(version)));
  const next = patch(base, state, diff(state, baseline, []));
  return { state: next, version, ...(Object.keys(kept).length === 0 ? {} : { kept }), ...Object.fromEntries(others) };
}

const isObject = kinds.object.fits;

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
