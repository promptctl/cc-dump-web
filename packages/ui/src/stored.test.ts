import type { Event } from "@cc-dump/log/event";
import { startTrace } from "@cc-dump/log/event";
import { Malformed } from "@cc-dump/log/failure";
import { kinds, tolerant, value, type Read } from "@cc-dump/log/json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StoredEvent } from "./stored.ts";
import { memoryStorage } from "./testing.ts";

type Chosen = { name: string; on: boolean };
const first: Chosen = { name: "none", on: false };
const readChosen = (state: unknown): Read<Chosen> => tolerant<Chosen>({ name: value(kinds.string), on: value(kinds.boolean) }, first)(state, []);
const name = "cc-dump.settings";
const item = (state: unknown, version = 0) => JSON.stringify({ state, version });

// The storage module as a page loads it, its events going nowhere yet, and a store kept in `storage` through it as the
// UI's are, read as it is made.
async function loaded() {
  vi.resetModules();
  const module = await import("./stored.ts");
  const storeIn = (storage: Storage, read = readChosen) =>
    create<Chosen>()(persist(() => first, module.stored({ name, version: 0, storage: () => storage, initial: first, read })));
  return { ...module, storeIn };
}

// The same, its events reported to `events` from the start.
async function reported() {
  const module = await loaded();
  const events: StoredEvent[] = [];
  module.reportStored((event) => events.push(event));
  return { ...module, events };
}

// A storage whose reads fail while `blocked.reads` says so, and whose writes the storage refuses while `blocked.writes`
// says so.
function blockable(storage: Storage) {
  const blocked = { reads: false, writes: false };
  const refuse = (is: boolean, error: DOMException) => {
    if (is) throw error;
  };
  return {
    blocked,
    storage: {
      ...storage,
      getItem: (key: string) => (refuse(blocked.reads, new DOMException("blocked", "SecurityError")), storage.getItem(key)),
      setItem: (key: string, text: string) => (refuse(blocked.writes, new DOMException("full", "QuotaExceededError")), storage.setItem(key, text)),
      removeItem: (key: string) => (refuse(blocked.writes, new DOMException("full", "QuotaExceededError")), storage.removeItem(key)),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a stored item's read", () => {
  it("reads nothing stored as the store's first state", async () => {
    const { storeIn, events } = await reported();
    const store = storeIn(memoryStorage().storage);
    expect(store.getState()).toEqual(first);
    expect(events).toMatchObject([{ store: name, is: "read", read: { stored: "none" } }]);
  });

  it("reads an item stored as persist stores it, naming what it dropped, and each field it does not read at any depth, by its path in the item", async () => {
    const { storeIn, events } = await reported();
    const store = storeIn(memoryStorage({ [name]: JSON.stringify({ state: { name: "a", on: "yes", later: { x: 1 } }, version: 0, by: "a later build" }) }).storage);
    expect(store.getState()).toEqual({ name: "a", on: false });
    expect(events).toMatchObject([
      {
        store: name,
        is: "read",
        read: {
          stored: "read",
          version: 0,
          dropped: [
            { at: ["by"], why: "is not read by this build" },
            { at: ["state", "on"], why: "is not a boolean" },
            { at: ["state", "later"], why: "is not read by this build" },
          ],
        },
      },
    ]);
  });

  it.each([["{"], [JSON.stringify({ name: "a" })]])("reads an item that is not one, %s, as the store's first state, and replaces it at the next write", async (text) => {
    const { storeIn, events } = await reported();
    const { storage, held } = memoryStorage({ [name]: text });
    const store = storeIn(storage);
    expect(store.getState()).toEqual(first);
    expect(events[0]).toMatchObject({ is: "read", read: { stored: "unreadable" } });
    store.setState({ name: "b" });
    expect(held.get(name)).toBe(item({ name: "b", on: false }));
  });

  it("reads an item that is not one as the store's first state again, as the store holds another", async () => {
    const { storeIn } = await reported();
    const { storage, held } = memoryStorage();
    const store = storeIn(storage);
    store.setState({ on: true });
    held.set(name, "{");
    await store.persist.rehydrate();
    expect(store.getState()).toEqual(first);
  });

  it("writes nothing over what is stored after the storage failed as it was read, until a read reaches it", async () => {
    const { storeIn, events } = await reported();
    const { storage, writes } = memoryStorage({ [name]: item({ name: "a", on: true }) });
    const { blocked, storage: blocking } = blockable(storage);
    blocked.reads = true;
    const store = storeIn(blocking);
    store.setState({ name: "b" });
    store.setState({ name: "c" });
    expect(store.getState()).toEqual({ name: "c", on: false });
    expect(writes).toEqual([]);
    blocked.reads = false;
    await store.persist.rehydrate();
    expect(store.getState()).toEqual({ name: "a", on: true });
    store.setState({ on: false });
    expect(writes).toEqual([[name, item({ name: "a", on: false })]]);
    expect(events).toMatchObject([
      { is: "read", read: { stored: "failed", error: { name: "SecurityError" } } },
      { is: "read", read: { stored: "read" } },
    ]);
  });

  it("reports this build's own bug in a read, which persist would swallow, and writes nothing over what is stored", async () => {
    const { storeIn, events } = await reported();
    const { storage, writes } = memoryStorage({ [name]: item({ name: "a", on: true }) });
    const bug = new TypeError("not a function");
    const store = storeIn(storage, () => {
      throw bug;
    });
    store.setState({ name: "b" });
    expect(store.getState()).toEqual({ name: "b", on: false });
    expect(writes).toEqual([]);
    expect(events).toMatchObject([{ is: "read", read: { stored: "threw", error: bug } }]);
  });
});

describe("a stored item's write", () => {
  it("writes the reader's changes, and a read again writes nothing", async () => {
    const { storeIn } = await reported();
    const { storage, held, writes } = memoryStorage();
    const store = storeIn(storage);
    store.setState({ on: true });
    expect(writes).toEqual([[name, item({ name: "none", on: true })]]);
    held.set(name, item({ name: "elsewhere", on: true }));
    await store.persist.rehydrate();
    expect(store.getState()).toEqual({ name: "elsewhere", on: true });
    expect(writes).toHaveLength(1);
  });

  it("never throws a write the storage refuses into the change, and reports a run of them as it begins and, on its span, as it ends", async () => {
    const { storeIn, events } = await reported();
    const { blocked, storage } = blockable(memoryStorage().storage);
    const store = storeIn(storage);
    blocked.writes = true;
    store.setState({ name: "a" });
    store.setState({ name: "b" });
    store.persist.clearStorage();
    blocked.writes = false;
    store.setState({ name: "c" });
    blocked.writes = true;
    store.setState({ name: "d" });
    expect(events.slice(1)).toMatchObject([
      { is: "write_refused", error: { name: "QuotaExceededError" } },
      { is: "writes_resumed" },
      { is: "write_refused" },
    ]);
    expect(events[2]!.span.trace_id).toBe(events[1]!.span.trace_id);
    expect(events[3]!.span.trace_id).not.toBe(events[1]!.span.trace_id);
  });

  it("neither ends nor begins a run of refusals at a read, whether it reached what is stored or not", async () => {
    const { storeIn, events } = await reported();
    const { blocked, storage } = blockable(memoryStorage().storage);
    const store = storeIn(storage);
    blocked.writes = true;
    store.setState({ name: "a" });
    blocked.reads = true;
    await store.persist.rehydrate();
    blocked.reads = false;
    await store.persist.rehydrate();
    store.setState({ name: "b" });
    expect(events.map(({ is }) => is)).toEqual(["read", "write_refused", "read", "read"]);
  });

  it("passes a bug in what it writes as it is, not as the storage's refusal", async () => {
    const { storeIn, events } = await reported();
    const store = storeIn(memoryStorage().storage);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => store.setState({ name: cycle as never })).toThrow(TypeError);
    expect(events.filter(({ is }) => is === "write_refused")).toEqual([]);
  });
});

describe("the storage's events", () => {
  it("are held until the page says where they go, then handed over, each timed as it happened", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-22T10:00:00.000Z"), toFake: ["Date", "performance"] });
    const { storeIn, reportStored, storedLog } = await loaded();
    storeIn(memoryStorage().storage);
    vi.advanceTimersByTime(5000);
    const lines: Event[] = [];
    reportStored(storedLog((line) => lines.push(line)));
    expect(lines).toMatchObject([{ event: "stored_read", stored: "none", started_at: "2026-11-22T10:00:00.000Z", duration_ms: 0 }]);
  });

  it("go to one report: a second is refused", async () => {
    const { reportStored } = await reported();
    expect(() => reportStored(() => {})).toThrow("already go to a report");
  });

  it("are written to the page's log, each read as `stored_read` saying how it was read", async () => {
    const { storedLog } = await loaded();
    const lines: Event[] = [];
    const log = storedLog((event) => lines.push(event));
    const span = startTrace();
    log({ store: name, span, is: "read", read: { stored: "none" } });
    log({ store: "cc-dump.view", span, is: "read", read: { stored: "read", version: 6, dropped: [{ at: ["state", "opened"], why: "names a row" }] } });
    log({ store: name, span, is: "read", read: { stored: "unreadable", error: new Malformed("is not JSON") } });
    log({ store: name, span, is: "read", read: { stored: "failed", error: new DOMException("blocked", "SecurityError") } });
    log({ store: name, span, is: "read", read: { stored: "threw", error: new TypeError("not a function") } });
    log({ store: name, span, is: "write_refused", error: new DOMException("full", "QuotaExceededError") });
    log({ store: name, span, is: "writes_resumed" });
    expect(lines).toMatchObject([
      { event: "stored_read", store: name, stored: "none", dropped: [], writes: "made", outcome: "ok" },
      { event: "stored_read", store: "cc-dump.view", stored: "read", version: 6, dropped: [{ at: ["state", "opened"], why: "names a row" }], writes: "made", outcome: "ok" },
      { event: "stored_read", store: name, stored: "unreadable", writes: "made", outcome: "error" },
      { event: "stored_read", store: name, stored: "failed", writes: "skipped", outcome: "error" },
      { event: "stored_read", store: name, stored: "threw", writes: "skipped", outcome: "error" },
      { event: "stored_write_refused", store: name, outcome: "error" },
      { event: "stored_writes_resumed", store: name, outcome: "ok" },
    ]);
    expect(new Set(lines.map(({ trace_id }) => trace_id)).size).toBe(1);
  });
});

describe("a change another tab made", () => {
  it("is to an item when it is in the item's storage, at its name or clearing the storage", async () => {
    const { changes } = await loaded();
    const kept = memoryStorage().storage;
    const other = memoryStorage().storage;
    const settings = { name, version: 0, storage: () => kept, initial: first, read: readChosen } as const;
    expect(changes(settings, { storageArea: kept, key: name })).toBe(true);
    expect(changes(settings, { storageArea: kept, key: null })).toBe(true);
    expect(changes(settings, { storageArea: kept, key: "cc-dump.view" })).toBe(false);
    expect(changes(settings, { storageArea: other, key: null })).toBe(false);
  });
});
