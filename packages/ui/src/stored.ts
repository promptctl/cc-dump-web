import type { Ending } from "@cc-dump/log/ending";
import type { Facts, Log } from "@cc-dump/log/event";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, object, parseJson, raw, value, type Dropped, type Read } from "@cc-dump/log/json";
import type { PersistStorage } from "zustand/middleware";
import { decided, failed } from "./log.ts";

// The items the UI keeps in a Web Storage: the tab's view (view/state.ts) and the reader's settings (settings.ts).
export type StoreName = "cc-dump.view" | "cc-dump.settings";

// [LAW:nothing-unseen] How an item was read: nothing was stored; it was read, under the version it was stored by, with
// each part of it this build did not take; what is stored is not an item (not JSON, or not `{state, version}`), so it
// is replaced at the next write; or the storage failed as it was reached, so what it holds is not known.
export type StoredRead =
  | { stored: "none" }
  | { stored: "read"; version: number; dropped: readonly Dropped[] }
  | { stored: "unreadable"; error: Malformed }
  | { stored: "failed"; error: unknown };

// What the UI's storage reports: each read of an item, and the first write of a run the storage refused.
export type StoredEvent = { store: StoreName } & ({ is: "read"; read: StoredRead } | { is: "write_refused"; error: unknown });
export type Report = (event: StoredEvent) => void;

// [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling] Where the storage's events go, owned here: held
// until the composition root says where (`reportStored`), then sent there. A store reads its item as its module loads,
// before the page's log exists, so its first read is held, not lost, in whatever order the modules load.
let report: Report | StoredEvent[] = [];
const emit = (event: StoredEvent) => (Array.isArray(report) ? report.push(event) : report(event));

export function reportStored(to: Report): void {
  const held = Array.isArray(report) ? report : [];
  report = to;
  held.forEach(to);
}

// An item as one store keeps it: its name, the version this build stores it under, the storage it is kept in, and how
// a stored state is read, by the version it was stored under.
export type Item<T> = { name: StoreName; version: number; storage: () => Storage; read: (state: unknown, version: number) => Read<T> };

// [LAW:single-enforcer] [LAW:one-source-of-truth] An item's options for zustand `persist`, which owns the item from
// here: it reads it as the store is made and again as `rehydrate` asks, through the raw set, which writes nothing, and
// writes it as the reader changes the store. The item is stored as persist stores it, `{state, version}`, so an item
// any build stored is read by this read. Every stored version is read here, so the state persist is given is always of
// this one's, and it never migrates.
export function stored<T>({ name, version, storage, read }: Item<T>): { name: StoreName; version: number; storage: PersistStorage<T> } {
  // [LAW:no-ambient-temporal-coupling] Whether what is stored is known: not until a read reached it. Until then a
  // write would put the store's state over an item nobody read.
  let known = false;
  // Whether the last write was refused, so a run of refusals is reported once.
  let refused = false;
  return {
    name,
    version,
    storage: {
      getItem: () => {
        const { read: outcome, state } = readItem({ name, version, storage, read });
        known = outcome.stored !== "failed";
        emit({ store: name, is: "read", read: outcome });
        return state === undefined ? null : { state: state.value, version };
      },
      setItem: (_, item) => {
        // [LAW:no-silent-failure] A write held so is not unseen: the read that failed said so, `writes: "held"`.
        if (!known) return;
        const text = JSON.stringify(item);
        const written = reach(storage, (kept) => kept.setItem(name, text));
        if ("error" in written && !refused) emit({ store: name, is: "write_refused", error: written.error });
        refused = "error" in written;
      },
      removeItem: () => storage().removeItem(name),
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

// [LAW:parse-dont-validate] The item stored under `name`, read: how, and the state it gives persist, or none, where the
// state the store holds stays. Nothing stored is the state read from nothing, the store's first, so a store whose item
// another tab removed is read back to its first state.
function readItem<T>({ name, version, storage, read }: Item<T>): { read: StoredRead; state?: { value: T } } {
  const text = reach(storage, (kept) => kept.getItem(name));
  if ("error" in text) return { read: { stored: "failed", error: text.error } };
  if (text.ok === null) return { read: { stored: "none" }, state: { value: read(undefined, version).value } };
  try {
    const envelope = envelopeOf(parseJson(text.ok, name));
    const state = read(envelope.value.state, envelope.value.version);
    const dropped = [...envelope.dropped, ...state.dropped.map(({ at, why }) => ({ at: ["state", ...at], why }))];
    return { read: { stored: "read", version: envelope.value.version, dropped }, state: { value: state.value } };
  } catch (error) {
    if (!(error instanceof Malformed)) throw error;
    return { read: { stored: "unreadable", error } };
  }
}

const envelope = object<{ state: unknown; version: number }>({ state: raw, version: value(kinds.integer) });
const envelopeOf = (json: unknown) => envelope(json, []);

// [LAW:nothing-unseen] The storage's events written to `log`: `stored_read`, at each read of an item, which says
// whether anything was stored and names each part dropped, or the failure, and `stored_write_refused`, as a run of
// writes the storage refuses (a full quota) begins.
export const storedLog =
  (log: Log): Report =>
  (event) => {
    const [name, facts, ending] = event.is === "read" ? (["stored_read", ...readFacts(event.read)] as const) : (["stored_write_refused", {}, failed(event.error)] as const);
    decided(log, name, { store: event.store, ...facts }, ending);
  };

function readFacts(read: StoredRead): [Facts, Ending] {
  switch (read.stored) {
    case "none":
      return [{ stored: false, dropped: [] }, { outcome: "ok" }];
    case "read":
      return [{ stored: true, version: read.version, dropped: read.dropped }, { outcome: "ok" }];
    case "unreadable":
      return [{ stored: true }, failed(read.error)];
    case "failed":
      return [{ writes: "held" }, failed(read.error)];
  }
}
