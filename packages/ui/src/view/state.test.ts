import { beforeEach, describe, expect, it } from "vitest";
import { events, useEvents } from "../store.ts";
import { useView, view } from "./state.ts";

describe("opening a recording", () => {
  beforeEach(() => {
    useView.setState(useView.getInitialState(), true);
    events.reset();
  });

  it("opens it at its end with no current match, keeping the flips", () => {
    const match = { key: "t1/request/http", at: "text", start: 0 };
    useView.setState({ flipped: { "t1/request/http": true }, position: { at: "row", key: "t1", offset: 12 }, search: { query: "x", current: match } });
    view.open({ recording: "past", name: "20261113T080000.000Z.jsonl" });
    expect(useView.getState()).toMatchObject({
      open: { recording: "past", name: "20261113T080000.000Z.jsonl" },
      flipped: { "t1/request/http": true },
      position: { at: "end" },
      search: { query: "x", current: undefined },
    });
  });

  it("never has it open with the last recording's events", () => {
    events.append([{ timestamp: "2026-11-13T08:00:00.000Z", trace_id: "t1", type: "request_body", base64: "" }]);
    const seen: number[] = [];
    const unsubscribe = useView.subscribe(({ open }) => open.recording === "past" && seen.push(useEvents.getState().events.length));
    view.open({ recording: "past", name: "20261113T080000.000Z.jsonl" });
    unsubscribe();
    expect(seen).toEqual([0]);
  });
});
