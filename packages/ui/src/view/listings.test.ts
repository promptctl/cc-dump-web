import { parseRecordingName } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { entriesOf } from "./listings.ts";

const listed = (...names: string[]) => names.map((name) => ({ name }));

describe("entriesOf", () => {
  it("lists the newest start first, and for a start both share an agent's before the proxy run's", () => {
    const entries = entriesOf(
      listed("20261113T080000.000Z.jsonl", "run-20261113T090000.000Z.jsonl", "run-20261113T080000.000Z.jsonl", "20261113T090000.000Z.jsonl", "20261114T010000.000Z.jsonl"),
    );
    expect(entries.map(({ listing }) => listing.name)).toEqual([
      "20261114T010000.000Z.jsonl",
      "20261113T090000.000Z.jsonl",
      "run-20261113T090000.000Z.jsonl",
      "20261113T080000.000Z.jsonl",
      "run-20261113T080000.000Z.jsonl",
    ]);
  });

  it("puts a file no part of the app named after every recording that has a start, in the order it was listed", () => {
    const entries = entriesOf(listed("b.jsonl", "20200101T000000.000Z.jsonl", "a.jsonl", "run-20201231T000000.000Z.jsonl"));
    expect(entries.map(({ listing }) => listing.name)).toEqual(["run-20201231T000000.000Z.jsonl", "20200101T000000.000Z.jsonl", "b.jsonl", "a.jsonl"]);
  });

  it("holds what each name parsed to, once, beside the listing", () => {
    const name = "20261113T080000.000Z.jsonl";
    expect(entriesOf(listed(name, "notes.jsonl"))).toEqual([
      { listing: { name }, parsed: parseRecordingName(name) },
      { listing: { name: "notes.jsonl" }, parsed: undefined },
    ]);
  });
});
