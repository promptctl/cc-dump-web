import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSettings, useSettings } from "../settings.ts";
import { events, useEvents } from "../store.ts";
import { useView, view } from "./state.ts";

const agent = "20261113T080000.000Z.jsonl";

describe("opening a recording", () => {
  beforeEach(() => {
    useView.setState(useView.getInitialState(), true);
    events.clear();
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

  // What a read depends on besides the name (useRecording): a retry of a failed read opens the recording already open.
  it("changes what a read depends on whenever a recording is opened, the one already open again too, and not when a read empties the events", () => {
    view.open(agent);
    const first = useEvents.getState().read;
    view.open(agent);
    const again = useEvents.getState().read;
    events.clear();

    expect(again).not.toBe(first);
    expect(useEvents.getState().read).toBe(again);
    expect(useView.getState().open).toBe(agent);
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

describe("the moment", () => {
  const place = { at: "row", key: "t1", offset: 4 } as const;
  beforeEach(() => useView.setState(useView.getInitialState(), true));

  it("is never changed by the view's own placing, now or held", () => {
    view.place(place, "view", "t9");
    expect(useView.getState().moment).toEqual({ at: "now" });
    useView.setState({ moment: { at: "chosen", trace: "t3" } });
    view.place(place, "view", "t9");
    expect(useView.getState().moment).toEqual({ at: "chosen", trace: "t3" });
  });

  it("is left at now's step by a reader's act away from it, and is now again at the end", () => {
    view.place(place, "reader", "t9");
    expect(useView.getState()).toMatchObject({ position: place, moment: { at: "left", trace: "t9" } });
    // Another act leaves it where it was left.
    view.place({ ...place, offset: 9 }, "reader", "t10");
    expect(useView.getState().moment).toEqual({ at: "left", trace: "t9" });
    view.place({ at: "end" }, "reader", "t10");
    expect(useView.getState().moment).toEqual({ at: "now" });
    // A step of the search is the reader's act too.
    view.goTo({ match: { key: "t1/request/http", at: "name", start: 0 }, block: undefined, regions: [] }, "t10");
    expect(useView.getState().moment).toEqual({ at: "left", trace: "t10" });
  });

  it("is a step chosen in time, which a reader's act keeps, until the end resumes following", () => {
    view.moveInTime({ at: "chosen", trace: "t3" }, place);
    view.place({ ...place, offset: 9 }, "reader", "t10");
    expect(useView.getState()).toMatchObject({ position: { ...place, offset: 9 }, moment: { at: "chosen", trace: "t3" } });
    view.place({ at: "end" }, "view", "t10");
    expect(useView.getState().moment).toEqual({ at: "now" });
  });

  it("opens a recording now", () => {
    useView.setState({ moment: { at: "chosen", trace: "t3" } });
    view.open(agent);
    expect(useView.getState().moment).toEqual({ at: "now" });
  });
});

describe("a view stored by another version", () => {
  it("opens the tab as a new one, with none open", async () => {
    const stored = new Map([["cc-dump.view", JSON.stringify({ state: { open: { recording: "live" }, flipped: { k: true } }, version: 1 })]]);
    useView.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: (key) => stored.get(key) ?? null, setItem: () => {}, removeItem: () => {} })) });
    useView.setState(useView.getInitialState(), true);

    await useView.persist.rehydrate();

    expect(useView.getState()).toMatchObject({ open: null, flipped: {} });
  });
});
