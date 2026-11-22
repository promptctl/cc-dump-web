import type { Ending } from "@cc-dump/log/ending";
import { startTrace, type Facts, type Log, type Span } from "@cc-dump/log/event";
import { Malformed } from "@cc-dump/log/failure";
import { drop, kinds, object, parseJson, raw, value, type Dropped, type Read } from "@cc-dump/log/json";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { decided, failed } from "./log.ts";

// The items the UI keeps in a Web Storage: the tab's view (view/state.ts) and the reader's settings (settings.ts).
export type StoreName = "cc-dump.view" | "cc-dump.settings";

// [LAW:nothing-unseen] How an item was read: nothing was stored; it was read, under the version it was stored by, with
// each part of it this build did not take; what is stored is not an item (not JSON, or not `{state, version}`), so it
// is replaced at the next write; the storage failed as it was reached, so what it holds is not known; or this build's
// own read threw, its bug, so what it holds is not known either.
export type StoredRead =
  | { stored: "none" }
  | { stored: "read"; version: number; dropped: readonly Dropped[] }
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
// writes it as the reader changes the store. The item is stored as persist stores it, `{state, version}`, so an item
// any build stored is read by this read. Every stored version is read here, so the state persist is given is always of
// this one's, and it never migrates.
export function stored<T>(item: Item<T>): { name: StoreName; version: number; storage: PersistStorage<T> } {
  const { name, version, storage } = item;
  // [LAW:no-ambient-temporal-coupling] The item's two facts, independent, each the one owner of what it gates. Whether
  // the last read reached what is stored: until one has, a write would put the store's state over an item nobody read,
  // so none is made, as that read's event says. And the run of writes the storage is refusing, on the span it began
  // on, which only a write the storage takes ends.
  let known = false;
  let refusing: Span | undefined;
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
        const { read, state } = readItem(item);
        emit({ store: name, span: ended(span), is: "read", read });
        known = reached(read);
        return state;
      },
      setItem: (_, stored) => {
        const text = JSON.stringify(stored);
        write((kept) => kept.setItem(name, text));
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
function readItem<T>({ name, version, storage, initial, read }: Item<T>): { read: StoredRead; state: StorageValue<T> | null } {
  const text = reach(storage, (kept) => kept.getItem(name));
  if ("error" in text) return { read: { stored: "failed", error: text.error }, state: null };
  if (text.ok === null) return { read: { stored: "none" }, state: { state: initial, version } };
  try {
    const envelope = envelopeOf(parseJson(text.ok, name));
    const state = read(envelope.value.state, envelope.value.version);
    const dropped = [...envelope.dropped, ...state.dropped.map(({ at, why }) => ({ at: ["state", ...at], why }))];
    return { read: { stored: "read", version: envelope.value.version, dropped }, state: { state: state.value, version } };
  } catch (error) {
    // [LAW:no-silent-failure] persist swallows what `getItem` throws, so this build's own bug is reported here.
    return error instanceof Malformed ? { read: { stored: "unreadable", error }, state: { state: initial, version } } : { read: { stored: "threw", error }, state: null };
  }
}

const envelope = drop(object<{ state: unknown; version: number }>({ state: raw, version: value(kinds.integer) }));
const envelopeOf = (json: unknown) => envelope(json, []);

// Whether a change another tab made to a storage (a `StorageEvent`) is to `item`: in its storage, at its name, or a
// clear of the whole storage.
export const changes = ({ name, storage }: Item<unknown>, { storageArea, key }: Pick<StorageEvent, "storageArea" | "key">): boolean =>
  storageArea === storage() && (key === null || key === name);

// [LAW:nothing-unseen] The storage's events written to `log`: `stored_read`, at each read of an item, which says how it
// was read (`stored`) and names each part dropped, or the failure, and whether writes are made after it (`writes`); `stored_write_refused`, as a run of writes the storage refuses (a full quota) begins; and
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
      return [{ dropped: [] }, { outcome: "ok" }];
    case "read":
      return [{ version: read.version, dropped: read.dropped }, { outcome: "ok" }];
    case "unreadable":
    case "failed":
    case "threw":
      return [{}, failed(read.error)];
  }
}
