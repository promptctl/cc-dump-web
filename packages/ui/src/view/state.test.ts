import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSettings, useSettings } from "../settings.ts";
import { events, useEvents } from "../store.ts";
import { useView, view } from "./state.ts";

const agent = "20261113T080000.000Z.jsonl";

describe("opening a recording", () => {
  beforeEach(() => {
    useView.setState(useView.getInitialState(), true);
    events.reset();
  });

  it("opens a tab with none open", () => {
    expect(useView.getState().open).toBeNull();
  });

  it("opens it by its name, at its end with no current match, keeping the flips", () => {
    const match = { key: "t1/request/http", at: "text", start: 0 };
    useView.setState({ flipped: { "t1/request/http": true }, position: { at: "row", key: "t1", offset: 12 }, search: { query: "x", current: match } });
    view.open(agent);
    expect(useView.getState()).toMatchObject({
      open: agent,
      flipped: { "t1/request/http": true },
      position: { at: "end" },
      search: { query: "x", current: undefined },
    });
  });

  it("never has it open with the last recording's events", () => {
    events.append([{ timestamp: "2026-11-13T08:00:00.000Z", trace_id: "t1", type: "request_body", base64: "" }]);
    const seen: number[] = [];
    const unsubscribe = useView.subscribe(({ open }) => open === agent && seen.push(useEvents.getState().events.length));
    view.open(agent);
    unsubscribe();
    expect(seen).toEqual([0]);
  });
});

describe("the search", () => {
  const match = { key: "t1/request/http", at: "text", start: 0 };
  beforeEach(() => {
    useSettings.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} })) });
    useView.setState(useView.getInitialState(), true);
    useSettings.setState(parseSettings(undefined));
  });

  it("has no current match after a change of query, or of how the query is read", () => {
    useView.setState({ search: { query: "x", current: match } });
    view.search("xy");
    expect(useView.getState().search).toEqual({ query: "xy", current: undefined });

    useView.setState({ search: { query: "x", current: match } });
    view.searchOption("wholeWord", true);
    expect(useView.getState().search).toEqual({ query: "x", current: undefined });
    expect(useSettings.getState().search.wholeWord).toBe(true);
  });
});

describe("a view stored by another version", () => {
  it("opens the tab as a new one, with none open", async () => {
    const stored = new Map([["cc-dump.view", JSON.stringify({ state: { open: { recording: "live" }, flipped: { k: true } }, version: 0 })]]);
    useView.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: (key) => stored.get(key) ?? null, setItem: () => {}, removeItem: () => {} })) });
    useView.setState(useView.getInitialState(), true);

    await useView.persist.rehydrate();

    expect(useView.getState()).toMatchObject({ open: null, flipped: {} });
  });
});
