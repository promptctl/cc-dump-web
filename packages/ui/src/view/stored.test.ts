import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { keepStored, readStored } from "../stored.ts";
import { memoryStorage } from "../testing.ts";
import { rowKeys } from "./rows.ts";
import { useView, viewItem, type View } from "./state.ts";

const initial = useView.getInitialState();
const chosen: View = {
  open: "20261113T080000.000Z.jsonl",
  terminal: { window: { start_time: 1763020800, session_id: "$1", window_id: "@3" }, shown: false },
  opened: { "t1/request/http": true, "thread:t1/tools/tools.Read.0": false },
  position: { at: "row", key: "t1/request/http", offset: 40 },
  moment: { at: "chosen", trace: "t1" },
  search: { query: "x", current: { key: "t1/request/http", at: "text", nth: 2, pattern: "/x/giu" } },
};

// The view as a tab stored it, under `keys`, read again.
const reread = (view: unknown, keys: unknown = rowKeys) => readStored(() => memoryStorage({ [viewItem.name]: JSON.stringify({ keys, view }) }), viewItem);

describe("a tab's stored view", () => {
  it("is read as the view kept, with nothing dropped", () => {
    const storage = memoryStorage();
    const store = createStore<View>()(() => initial);
    keepStored(store, () => storage, viewItem, () => expect.unreachable());
    store.setState(chosen, true);
    expect(readStored(() => storage, viewItem)).toEqual({ value: chosen, read: { stored: "read", dropped: {} } });
  });

  it("keeps the recording, place, folds and query when a current match is of a shape this build does not read", () => {
    // A match named by where it started, as an earlier build named one.
    const restored = reread({ ...chosen, search: { query: "x", current: { key: "t1/request/http", at: "0", start: 4 } } });
    expect(restored.value).toEqual({ ...chosen, search: { query: "x", current: null } });
    expect(Object.keys(restored.read.stored === "read" ? restored.read.dropped : {})).toEqual(["view.search.current"]);
  });

  it("drops the folds, place and current match kept by row keys of another scheme, and keeps the rest", () => {
    const restored = reread(chosen, rowKeys - 1);
    expect(restored.value).toEqual({ ...chosen, opened: {}, position: { at: "end" }, search: { query: "x", current: null } });
    expect(Object.keys(restored.read.stored === "read" ? restored.read.dropped : {})).toEqual(["view.opened", "view.position", "view.search.current"]);
  });

  it("opens as a new tab when what is stored holds no view, naming it", () => {
    // persist's {state, version}, as an earlier build stored the view.
    const restored = readStored(() => memoryStorage({ [viewItem.name]: JSON.stringify({ state: chosen, version: 7 }) }), viewItem);
    expect(restored).toEqual({ value: initial, read: { stored: "read", dropped: { view: "view: is not an object" } } });
  });

  it("reads a terminal's window as the server does, and a place's offset as one the view writes", () => {
    const restored = reread({ ...chosen, terminal: { window: { start_time: 1, session_id: "$01", window_id: "@3" }, shown: true }, position: { at: "row", key: "k", offset: -40 } });
    expect(restored.value).toEqual({ ...chosen, terminal: null, position: { at: "end" } });
    expect(Object.keys(restored.read.stored === "read" ? restored.read.dropped : {})).toEqual(["view.terminal", "view.position"]);
  });
});
