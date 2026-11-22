import { eventsWritten } from "@cc-dump/log/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { boolean, keep, keepStored, readStored, storedLog, text, type Dropped, type Item } from "./stored.ts";
import { memoryStorage } from "./testing.ts";

// A stored pair of a name and a map of choices.
type Pair = { name: string; choices: Record<string, boolean> };
const fallback: Pair = { name: "none", choices: {} };
const pair: Item<Pair> = {
  name: "pair",
  fallback,
  parse: (json, dropped) => keep({ fields: { name: text, choices: { entries: boolean } } }, fallback, json, "pair", dropped),
  write: (value) => value,
};

const storing = (json: unknown) => () => memoryStorage({ pair: JSON.stringify(json) });

describe("a stored item", () => {
  it("reads as the value written for it, with nothing dropped", () => {
    const storage = memoryStorage();
    const store = createStore<Pair>()(() => fallback);
    keepStored(store, () => storage, pair, () => expect.unreachable());
    store.setState({ name: "kept", choices: { a: true, b: false } });
    expect(readStored(() => storage, pair)).toEqual({ value: { name: "kept", choices: { a: true, b: false } }, read: { stored: "read", dropped: {} } });
  });

  it("keeps each field it can read, and drops each it cannot to the fallback's, naming it and why", () => {
    expect(readStored(storing({ name: 7, choices: { a: true }, extra: 1 }), pair)).toEqual({
      value: { name: "none", choices: { a: true } },
      read: { stored: "read", dropped: { "pair.name": "pair.name: is not a string", "pair.extra": "is not read by this build" } },
    });
    expect(readStored(storing({ choices: {} }), pair).read).toEqual({ stored: "read", dropped: { "pair.name": "is missing" } });
  });

  it("drops an entry of a map of choices alone", () => {
    expect(readStored(storing({ name: "n", choices: { a: true, b: "yes", c: false } }), pair)).toEqual({
      value: { name: "n", choices: { a: true, c: false } },
      read: { stored: "read", dropped: { "pair.choices.b": "pair.choices.b: is not a boolean" } },
    });
  });

  it("is read whole as the fallback when it is not JSON, or not an object", () => {
    expect(readStored(() => memoryStorage({ pair: "{" }), pair)).toEqual({ value: fallback, read: { stored: "read", dropped: { pair: "pair: is not JSON" } } });
    expect(readStored(storing([1]), pair)).toEqual({ value: fallback, read: { stored: "read", dropped: { pair: "pair: is not an object" } } });
  });

  it("says whether nothing was stored, no storage is kept, or the storage failed", () => {
    expect(readStored(() => memoryStorage(), pair)).toEqual({ value: fallback, read: { stored: "none" } });
    expect(readStored(() => undefined, pair)).toEqual({ value: fallback, read: { stored: "unavailable" } });
    const blocked = new DOMException("blocked", "SecurityError");
    expect(
      readStored(() => {
        throw blocked;
      }, pair),
    ).toEqual({ value: fallback, read: { stored: "failed", error: blocked } });
  });

  it("passes on an error of a parser that is not a refusal, as the parser's bug", () => {
    const broken: Item<Pair> = { ...pair, parse: (json, dropped: Dropped) => keep({ fields: { name: () => { throw new TypeError("bug"); }, choices: { entries: boolean } } }, fallback, json, "pair", dropped) };
    expect(() => readStored(storing({ name: "n", choices: {} }), broken)).toThrow(TypeError);
  });

  it("reports a write the storage refuses", () => {
    const refusals: unknown[] = [];
    const full = { ...memoryStorage(), setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };
    const store = createStore<Pair>()(() => fallback);
    keepStored(store, () => full, pair, (error) => refusals.push(error));
    store.setState({ name: "x" });
    expect(refusals).toEqual([expect.objectContaining({ name: "QuotaExceededError" })]);
  });
});

describe("the stored items' events", () => {
  it("write each read, with what was dropped, an empty one included, and a failure as its outcome", () => {
    const { events, log } = eventsWritten();
    const stored = storedLog(log);
    stored.read("view", { stored: "read", dropped: {} });
    stored.read("view", { stored: "none" });
    stored.read("settings", { stored: "read", dropped: { "settings.theme": "settings.theme: is not a theme this build has" } });
    stored.read("view", { stored: "failed", error: new Error("blocked") });
    stored.refused("view")(new Error("full"));
    expect(events).toEqual([
      expect.objectContaining({ event: "stored_read", outcome: "ok", store: "view", stored: "read", dropped: {} }),
      expect.objectContaining({ event: "stored_read", outcome: "ok", store: "view", stored: "none", dropped: {} }),
      expect.objectContaining({ event: "stored_read", outcome: "ok", store: "settings", dropped: { "settings.theme": "settings.theme: is not a theme this build has" } }),
      expect.objectContaining({ event: "stored_read", outcome: "error", store: "view", stored: "failed" }),
      expect.objectContaining({ event: "stored_write_refused", outcome: "error", store: "view" }),
    ]);
  });
});
