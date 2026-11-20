import { createJSONStorage } from "zustand/middleware";
import { beforeEach, describe, expect, it } from "vitest";
import type { KeyedBlock } from "../format/format.ts";
import { parseSettings, useSettings } from "../settings.ts";
import { events, useEvents } from "../store.ts";
import type { BlockRow } from "./rows.ts";
import { useView, view } from "./state.ts";

const agent = "20261113T080000.000Z.jsonl";
// A tool definition's row, in no set.
const read: KeyedBlock = { category: "tools", name: "Read", parts: [], key: "c" };
const row: BlockRow = { kind: "block", key: "thread:t1/tools/tools.Read.0", change: "added", versions: [{ step: 1, block: read, reply: false, rewrote: undefined, previous: undefined }], at: 0, set: undefined, depth: 0, dimmed: false };

describe("opening a recording", () => {
  beforeEach(() => {
    useView.setState(useView.getInitialState(), true);
    events.clear();
  });

  it("opens a tab with none open", () => {
    expect(useView.getState().open).toBeNull();
  });

  it("opens it by its name, at its end with no current match, keeping the reader's choices", () => {
    const match = { key: "t1/request/http", at: "text", start: 0 };
    useView.setState({ opened: { "t1/request/http": true }, position: { at: "row", key: "t1", offset: 12 }, search: { query: "x", current: match } });
    view.open(agent);
    expect(useView.getState()).toMatchObject({
      open: agent,
      opened: { "t1/request/http": true },
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

describe("a launch", () => {
  beforeEach(() => {
    useView.setState(useView.getInitialState(), true);
    events.clear();
  });

  it("opens a tab with no window", () => {
    expect(useView.getState().terminal).toBeNull();
  });

  it("opens its agent's recording and shows its window, which stays shown when another recording is opened", () => {
    view.launched({ session: "work", start_time: 1794801953, session_id: "$2", window_id: "@7", pane_id: "%9", recording: agent });
    const shown = { window: { start_time: 1794801953, session_id: "$2", window_id: "@7" }, shown: true };
    expect(useView.getState()).toMatchObject({ open: agent, terminal: shown, position: { at: "end" } });

    view.open("20261113T090000.000Z.jsonl");
    expect(useView.getState().terminal).toEqual(shown);
  });

  it("puts its terminal away, leaving the recording open and the window known, and shows it again", () => {
    view.launched({ session: "work", start_time: 1794801953, session_id: "$2", window_id: "@7", pane_id: "%9", recording: agent });
    const { window } = useView.getState().terminal!;
    view.showTerminal(false);
    expect(useView.getState()).toMatchObject({ open: agent, terminal: { window, shown: false } });
    view.showTerminal(true);
    expect(useView.getState().terminal).toEqual({ window, shown: true });
  });

  it("has no terminal to show before a launch", () => {
    view.showTerminal(true);
    expect(useView.getState().terminal).toBeNull();
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

  // What a step chose is the reader's choice, however the fold starts, so a change of level never hides the current match.
  it("chooses open a match's block and the regions holding it, and records nothing for a step among what they hold open", () => {
    view.goTo({ match, row, nests: [], inContent: true, regions: ["r"] }, "t1");
    expect(useView.getState().opened).toEqual({ [row.key]: true, r: true });
    // The next match in the same region: nothing is chosen, so the choices are the record they were.
    const { opened } = useView.getState();
    view.goTo({ match: { ...match, start: match.start + 1 }, row, nests: [], inContent: true, regions: ["r"] }, "t1");
    expect(useView.getState().opened).toBe(opened);
    expect(useView.getState().search.current).toEqual({ ...match, start: match.start + 1 });
    useView.setState({ opened: { [row.key]: false } });
    view.goTo({ match, row, nests: [], inContent: true, regions: [] }, "t1");
    expect(useView.getState().opened).toEqual({ [row.key]: true });
  });

  it("opens the nests a match's block is inside, and records no choice for one already open", () => {
    const nests = ["t1/inner/nest", "t1/outer/nest"];
    view.goTo({ match, row, nests, inContent: false, regions: [] }, "t1");
    expect(useView.getState().opened).toEqual({ "t1/inner/nest": true, "t1/outer/nest": true });
    const { opened } = useView.getState();
    view.goTo({ match, row, nests, inContent: false, regions: [] }, "t1");
    expect(useView.getState().opened).toBe(opened);
  });

  // A match on a block's line needs its row listed, and no more: the set's line opens, the block stays as it is.
  it("chooses open the set a match's block is in, and the block only for a match in its content", () => {
    const inSet = { ...row, set: "t1/tools" };
    view.goTo({ match, row: inSet, nests: [], inContent: false, regions: [] }, "t1");
    expect(useView.getState().opened).toEqual({ "t1/tools": true });
    view.goTo({ match, row: inSet, nests: [], inContent: true, regions: [] }, "t1");
    expect(useView.getState().opened).toEqual({ "t1/tools": true, [row.key]: true });
    useView.setState({ opened: { "t1/tools": false } });
    view.goTo({ match, row: inSet, nests: [], inContent: false, regions: [] }, "t1");
    expect(useView.getState().opened).toEqual({ "t1/tools": true });
  });
});

describe("a click on an entry of a text's contents", () => {
  beforeEach(() => useView.setState(useView.getInitialState(), true));

  it("opens the folds that show its heading, one the reader closed with them, and moves to its block's row, leaving now and the search as it was", () => {
    const search = { query: "x", current: { key: "elsewhere", at: "name", start: 0 } };
    useView.setState({ opened: { "p/2": false, other: false }, search });
    view.toHeading(row.key, ["p/2", "p/6"], "t4");
    expect(useView.getState()).toMatchObject({
      opened: { "p/2": true, "p/6": true, other: false },
      position: { at: "row", key: row.key, offset: 0 },
      moment: { at: "left", trace: "t4" },
      search,
    });
    // Its folds already chosen open, another click chooses nothing, so the choices are the record they were.
    const { opened } = useView.getState();
    view.toHeading(row.key, ["p/2", "p/6"], "t4");
    expect(useView.getState().opened).toBe(opened);
  });
});

describe("a block, region or fold toggled", () => {
  beforeEach(() => useView.setState(useView.getInitialState(), true));

  it("shows the other way from how it shows, and keeps the choice as made, the same as its start or not", () => {
    view.toggle("k", false);
    expect(useView.getState().opened).toEqual({ k: true });
    view.toggle("k", false);
    expect(useView.getState().opened).toEqual({ k: false });
  });

  // Closed at expanded and opened again, a block stays open at compact: the reader's last act was to open it.
  it("keeps the reader's last choice across a change of the level it starts at", () => {
    view.toggle("k", true);
    view.toggle("k", true);
    expect(useView.getState().opened).toEqual({ k: true });
    view.toggle("k", false);
    expect(useView.getState().opened).toEqual({ k: false });
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
    view.goTo({ match: { key: row.key, at: "name", start: 0 }, row, nests: [], inContent: false, regions: [] }, "t10");
    expect(useView.getState().moment).toEqual({ at: "left", trace: "t10" });
  });

  it("is a step chosen in time, which a reader's act keeps, until the end resumes following", () => {
    view.goTo({ match: { key: row.key, at: "name", start: 0 }, row, nests: [], inContent: false, regions: [] }, "t10");
    view.moveInTime({ at: "chosen", trace: "t3" }, place);
    // The match current was another moment's.
    expect(useView.getState().search.current).toBeUndefined();
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
    const stored = new Map([["cc-dump.view", JSON.stringify({ state: { open: { recording: "live" }, flipped: { k: true } }, version: 3 })]]);
    useView.persist.setOptions({ storage: createJSONStorage(() => ({ getItem: (key) => stored.get(key) ?? null, setItem: () => {}, removeItem: () => {} })) });
    useView.setState(useView.getInitialState(), true);

    await useView.persist.rehydrate();

    expect(useView.getState()).toMatchObject({ open: null, opened: {} });
  });
});
