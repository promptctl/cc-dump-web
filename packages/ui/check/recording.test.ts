import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe as said } from "@cc-dump/log/describe";
import type { RecordedEvent } from "@cc-dump/proxy/format";
import { afterAll, describe, expect, it } from "vitest";
import type { Reader } from "../src/connection/connection.ts";
import { recordedAt } from "../src/testing.ts";
import { fileConnection } from "./recording.ts";

const directory = mkdtempSync(join(tmpdir(), "cc-dump-check-"));
afterAll(() => rmSync(directory, { recursive: true }));

const at = recordedAt("2026-11-13T08:00:00.000Z");
const line = (event: RecordedEvent) => `${JSON.stringify(event)}\n`;

// What a read of `recording` delivers, in order, up to the end or failure it reports.
function readOf(recording: string): Promise<string[]> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const reader: Reader = {
      event: (event, offset) => void seen.push(`event ${event.type} ${offset}`),
      end: ({ unterminated_bytes }) => resolve([...seen, `ended with ${unterminated_bytes} bytes unread`]),
      failed: (error) => resolve([...seen, `failed ${said(error)}`]),
    };
    fileConnection.read(recording, reader, new AbortController().signal);
  });
}

describe("fileConnection", () => {
  it("delivers each whole event with the offset its line ends at, then the bytes a write cut short left", async () => {
    const body = line({ ...at("t1"), type: "request_body", base64: "" });
    const end = line({ ...at("t1"), type: "end", outcome: "ok" });
    const recording = join(directory, "cut.jsonl");
    writeFileSync(recording, body + end + '{"timesta');
    expect(await readOf(recording)).toEqual([
      `event request_body ${Buffer.byteLength(body)}`,
      `event end ${Buffer.byteLength(body) + Buffer.byteLength(end)}`,
      "ended with 9 bytes unread",
    ]);
  });

  it("fails a recording that is not there, naming it, and does not read it as empty", async () => {
    const [outcome] = await readOf(join(directory, "missing.jsonl"));
    expect(outcome).toMatch(/^failed .*ENOENT.*missing\.jsonl/);
  });

  it("throws the reason of a signal aborted before it begins, as every connection's read does", () => {
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    expect(() => fileConnection.read("any.jsonl", { event: () => {}, end: () => {}, failed: () => {} }, abort.signal)).toThrow("gone");
  });
});
