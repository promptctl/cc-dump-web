import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import { createFormatter } from "../format/format.ts";
import { createLayout, describeSize } from "./rows.ts";

const timestamp = "2026-11-13T08:00:00.000Z";
const request = (trace_id: string, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] },
  { timestamp, trace_id, type: "request_body", base64: Buffer.from(JSON.stringify(body)).toString("base64") },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
const body = { model: "m", messages: [{ role: "user", content: "Hello." }] };

describe("layout", () => {
  it("lays each exchange out as its line, then each group's title and blocks, keyed by what they are", () => {
    const { rows, indexOf } = createLayout()(createFormatter()(exchanges([...request("a", body), ...request("b", body)])));
    const keys = rows.map(({ key }) => key);
    expect(keys.slice(0, 7)).toEqual(["a", "a/request", "a/request/http", "a/request/parameters", "a/message.0", "a/message.0/content.0", "a/response"]);
    expect(indexOf("b/message.0/content.0")).toBe(keys.indexOf("b/message.0/content.0"));
    expect(indexOf("b/message.9/content.0")).toBeUndefined();
    expect(indexOf("c/request")).toBeUndefined();
  });

  it("sizes a block by the characters of its content", () => {
    const { rows } = createLayout()(createFormatter()(exchanges(request("a", body))));
    expect(rows.find(({ key }) => key === "a/message.0/content.0")).toMatchObject({ size: "Hello.".length });
    expect([describeSize(999), describeSize(12_345), describeSize(2_500_000)]).toEqual(["999 chars", "12.3k chars", "2.5M chars"]);
  });

  it("lays an unchanged exchange out as the same rows", () => {
    const format = createFormatter();
    const layOut = createLayout();
    const a = request("a", body);
    const first = layOut(format(exchanges(a)));
    const later = layOut(format(exchanges([...a, ...request("b", body)])));
    expect(later.rows.slice(0, first.rows.length)).toEqual(first.rows);
    first.rows.forEach((row, index) => expect(later.rows[index]).toBe(row));
  });
});
