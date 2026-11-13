import type { Listing } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { isOpen, opening, useView, view } from "./state.ts";

const past: Listing = { name: "20261113T080000.000Z.jsonl", live: false };
const live: Listing = { name: "20261113T090000.000Z.jsonl", live: true };

describe("the recording open", () => {
  it("is the listing marked live while live is open, and the one by its name while a past one is", () => {
    expect([past, live].filter((listing) => isOpen({ recording: "live" }, listing))).toEqual([live]);
    expect([past, live].filter((listing) => isOpen({ recording: "past", name: past.name }, listing))).toEqual([past]);
  });

  it("is opened from a listing: live by its role, a past one by its name", () => {
    expect(opening(live)).toEqual({ recording: "live" });
    expect(opening(past)).toEqual({ recording: "past", name: past.name });
  });

  it("opens at its end with no current match, keeping the flips", () => {
    const match = { key: "t1/request/http", at: "text", start: 0 };
    useView.setState({ flipped: { "t1/request/http": true }, position: { at: "row", key: "t1", offset: 12 }, search: { query: "x", current: match } });
    view.open({ recording: "past", name: past.name });
    expect(useView.getState()).toMatchObject({
      open: { recording: "past", name: past.name },
      flipped: { "t1/request/http": true },
      position: { at: "end" },
      search: { query: "x", current: undefined },
    });
  });
});
