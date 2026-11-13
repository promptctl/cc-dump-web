import { describe, expect, it } from "vitest";
import { useView, view } from "./state.ts";

describe("opening a recording", () => {
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
});
