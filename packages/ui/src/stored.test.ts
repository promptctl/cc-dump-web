import type { Event } from "@cc-dump/log/event";
import { kept, kinds, value } from "@cc-dump/log/json";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { reportStored, stored, storedLog, type StoredEvent } from "./stored.ts";
import { memoryStorage } from "./testing.ts";

type Kept = { name: string; on: boolean };
const first: Kept = { name: "none", on: false };
const read = (state: unknown) => kept<Kept>({ name: value(kinds.string), on: value(kinds.boolean) }, first)(state, []);
const name = "cc-dump.settings";
const item = (state: unknown, version = 0) => JSON.stringify({ state, version });

// A store kept in `storage` as the UI's are, read as it is made.
const storeIn = (storage: Storage) => create<Kept>()(persist(() => first, stored({ name, version: 0, storage: () => storage, read })));

let events: StoredEvent[];
beforeEach(() => {
  events = [];
  reportStored((event) => events.push(event));
});

describe("a stored item's read", () => {
  it("reads nothing stored as the store's first state", () => {
    const store = storeIn(memoryStorage().storage);
    expect(store.getState()).toEqual(first);
    expect(events).toEqual([{ store: name, is: "read", read: { stored: "none" } }]);
  });

  it("reads an item stored as persist stores it, naming what it dropped by its path in the item", () => {
    const store = storeIn(memoryStorage({ [name]: JSON.stringify({ state: { name: "a", on: "yes" }, version: 0, by: "a later build" }) }).storage);
    expect(store.getState()).toEqual({ name: "a", on: false });
    expect(events).toEqual([
      {
        store: name,
        is: "read",
        read: {
          stored: "read",
          version: 0,
          dropped: [
            { at: ["by"], why: "is not read by this build" },
            { at: ["state", "on"], why: "is not a boolean" },
          ],
        },
      },
    ]);
  });

  it.each([["{"], [JSON.stringify({ name: "a" })]])("says an item that is not one, %s, is unreadable, and replaces it at the next write", (text) => {
    const { storage, held } = memoryStorage({ [name]: text });
    const store = storeIn(storage);
    expect(store.getState()).toEqual(first);
    expect(events[0]).toMatchObject({ is: "read", read: { stored: "unreadable" } });
    store.setState({ name: "b" });
    expect(held.get(name)).toBe(item({ name: "b", on: false }));
  });

  it("holds every write after the storage failed as it was read, so what it holds is not written over", () => {
    const { storage, writes } = memoryStorage({ [name]: item({ name: "a", on: true }) });
    const store = storeIn({
      ...storage,
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    store.setState({ name: "b" });
    expect(store.getState()).toEqual({ name: "b", on: false });
    expect(writes).toEqual([]);
    expect(events).toMatchObject([{ is: "read", read: { stored: "failed", error: { name: "SecurityError" } } }]);
  });
});

describe("a stored item's write", () => {
  it("writes the reader's changes, and a read again writes nothing", async () => {
    const { storage, held, writes } = memoryStorage();
    const store = storeIn(storage);
    store.setState({ on: true });
    expect(writes).toEqual([[name, item({ name: "none", on: true })]]);
    held.set(name, item({ name: "elsewhere", on: true }));
    await store.persist.rehydrate();
    expect(store.getState()).toEqual({ name: "elsewhere", on: true });
    expect(writes).toHaveLength(1);
  });

  it("never throws a write the storage refuses into the change, and reports a run of them once", () => {
    const { storage } = memoryStorage();
    let full = true;
    const store = storeIn({
      ...storage,
      setItem: (key, text) => {
        if (full) throw new DOMException("full", "QuotaExceededError");
        storage.setItem(key, text);
      },
    });
    store.setState({ name: "a" });
    store.setState({ name: "b" });
    full = false;
    store.setState({ name: "c" });
    full = true;
    store.setState({ name: "d" });
    expect(events.filter(({ is }) => is === "write_refused")).toHaveLength(2);
  });

  it("passes a bug in what it writes as it is, not as the storage's refusal", () => {
    const store = storeIn(memoryStorage().storage);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => store.setState({ name: cycle as never })).toThrow(TypeError);
    expect(events.filter(({ is }) => is === "write_refused")).toEqual([]);
  });
});

describe("the storage's events", () => {
  it("are held until the page says where they go, then handed over", async () => {
    // A fresh module: its events have gone nowhere yet.
    vi.resetModules();
    const fresh = await import("./stored.ts");
    const store = create<Kept>()(persist(() => first, fresh.stored({ name, version: 0, storage: () => memoryStorage().storage, read })));
    expect(store.getState()).toEqual(first);
    const handed: StoredEvent[] = [];
    fresh.reportStored((event) => handed.push(event));
    expect(handed).toEqual([{ store: name, is: "read", read: { stored: "none" } }]);
  });

  it("are written to the page's log, a read as `stored_read` and a refusal as `stored_write_refused`", () => {
    const lines: Event[] = [];
    const log = storedLog((event) => lines.push(event));
    log({ store: name, is: "read", read: { stored: "none" } });
    log({ store: "cc-dump.view", is: "read", read: { stored: "read", version: 6, dropped: [{ at: ["state", "opened"], why: "names a row" }] } });
    log({ store: name, is: "read", read: { stored: "failed", error: new DOMException("blocked", "SecurityError") } });
    log({ store: name, is: "write_refused", error: new DOMException("full", "QuotaExceededError") });
    expect(lines).toMatchObject([
      { event: "stored_read", store: name, stored: false, dropped: [], outcome: "ok" },
      { event: "stored_read", store: "cc-dump.view", stored: true, version: 6, dropped: [{ at: ["state", "opened"], why: "names a row" }], outcome: "ok" },
      { event: "stored_read", store: name, writes: "held", outcome: "error" },
      { event: "stored_write_refused", store: name, outcome: "error" },
    ]);
  });
});
