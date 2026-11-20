import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, Log } from "@cc-dump/log";
import { parseTraceId } from "@cc-dump/log/trace";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingName } from "./format.ts";
import { createRecordings } from "./recordings.ts";

const trace_id = parseTraceId("4bf92f3577b34da6a3ce929d0e0e4736");

const moment = new Date("2026-11-14T10:00:00.000Z");
const run = "run-20261114T090000.000Z.jsonl";

function recordings(now = moment, log: Log = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return createRecordings(log, dir, run, () => now);
}

describe("record", () => {
  it("fails loudly, and does not make the file again, when a recording `create` made is gone before its first event", () => {
    const logged: Event[] = [];
    const { dir, create, record } = recordings(moment, (event) => void logged.push(event));
    const name = create();
    rmSync(join(dir, name));

    record(name, trace_id)({ type: "end", outcome: "ok" });

    expect(readdirSync(dir)).toEqual([]);
    expect(logged).toMatchObject([{ event: "record", outcome: "error", error: expect.stringContaining("ENOENT") }]);
  });

  it("writes nothing of an exchange after its end, logging what came late as an error", () => {
    const logged: Event[] = [];
    const { dir, record } = recordings(moment, (event) => void logged.push(event));
    const seen = record(run, trace_id);

    seen({ type: "end", outcome: "ok" });
    seen({ type: "response_trailers", headers: [] });

    expect(readFileSync(join(dir, run), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).type)).toEqual(["end"]);
    expect(logged).toMatchObject([
      { event: "record", outcome: "ok" },
      { event: "record_late", trace_id, outcome: "error", error: "response_trailers seen after its exchange's end: not recorded" },
    ]);
  });
});

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

describe("readable", () => {
  it("is the bytes of a recording this run writes, and fails for one it does not", () => {
    const { create, record, readable } = recordings();
    const name = create();
    record(name, trace_id)({ type: "request_trailers", headers: [] });

    expect(readable(name)).toBeGreaterThan(0);
    expect(() => readable("20261101T000000.000Z.jsonl")).toThrow("this run holds no writer for it");
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
    for (const name of [run, continued]) record(name, trace_id)({ type: "request_trailers", headers: [] });

    expect([run, past, made, continued, "notes.jsonl"].map(follows)).toEqual([true, false, true, true, false]);
  });
});
