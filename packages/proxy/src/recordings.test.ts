import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingName } from "./format.ts";
import { createRecordings } from "./recordings.ts";

const moment = new Date("2026-11-14T10:00:00.000Z");
const run = "run-20261114T090000.000Z.jsonl";

function recordings(now = moment) {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return createRecordings(() => {}, dir, run, () => now);
}

describe("create", () => {
  it("names a recording for the moment, makes its file empty, and holds its writer, so it is followed", () => {
    const { dir, create, follows, readable } = recordings();

    const name = create();

    expect(name).toBe(recordingName(moment));
    expect(readFileSync(join(dir, name), "utf8")).toBe("");
    expect([follows(name), readable(name)]).toEqual([true, 0]);
  });

  it("takes the next millisecond for a name already taken, whether by a recording of this run or one already in the directory", () => {
    const { dir, create } = recordings();
    writeFileSync(join(dir, recordingName(moment)), '{"a":1}\n');

    const names = [create(), create(), create()];

    expect(names).toEqual([1, 2, 3].map((ms) => recordingName(new Date(moment.getTime() + ms))));
    expect(readdirSync(dir).sort()).toEqual([recordingName(moment), ...names].sort());
    expect(readFileSync(join(dir, recordingName(moment)), "utf8")).toBe('{"a":1}\n');
  });
});

describe("follows", () => {
  it("is exactly for the recordings this run holds a writer for", () => {
    const { dir, create, follows, record } = recordings();
    const past = "20261101T000000.000Z.jsonl";
    writeFileSync(join(dir, past), '{"a":1}\n');
    const made = create();
    const continued = "20261113T080000.000Z.jsonl";

    expect([run, past, made, continued, "notes.jsonl"].map(follows)).toEqual([false, false, true, false, false]);

    // The run's own recording from its first event, and an agent's that this run did not make from the request that
    // continues it, as after a restart of the proxy.
    for (const name of [run, continued]) record(name, "4bf92f3577b34da6a3ce929d0e0e4736")({ type: "request_trailers", headers: [] });

    expect([run, past, made, continued, "notes.jsonl"].map(follows)).toEqual([true, false, true, true, false]);
  });
});
