import type { RecordedEvent } from "@cc-dump/proxy/format";
import { describe, expect, it } from "vitest";
import { exchanges } from "../exchanges.ts";
import type { Category } from "../format/blocks.ts";
import { createFormatter } from "../format/format.ts";
import { parseSettings, type Visibility } from "../settings.ts";
import { clockTime, compact, createGroupRows, createLayout, describeSize, preview, seconds } from "./rows.ts";

const timestamp = "2026-11-13T08:00:00.000Z";
const request = (trace_id: string, body: unknown): RecordedEvent[] => [
  { timestamp, trace_id, type: "request", method: "POST", url: "/v1/messages", http_version: "1.1", headers: [] },
  { timestamp, trace_id, type: "request_body", base64: Buffer.from(JSON.stringify(body)).toString("base64") },
  { timestamp, trace_id, type: "request_trailers", headers: [] },
];
const body = { model: "m", messages: [{ role: "user", content: "Hello." }] };
const shown = parseSettings(undefined).visibility;
const layout = (visibility: Record<Category, Visibility>) => createLayout(visibility, createGroupRows());

describe("layout", () => {
  it("lays each exchange out as its line, then each group's title and blocks, keyed by what they are", () => {
    const { rows, keys } = layout(shown)(createFormatter()(exchanges([...request("a", body), ...request("b", body)])));
    const listed = rows.map(({ key }) => key);
    // A response not begun has no block, so no title over nothing.
    expect(listed.slice(0, 7)).toEqual(["a", "a/request", "a/request/http", "a/request/parameters", "a/message.0", "a/message.0/content.0", "b"]);
    expect(keys.indexOf("b/message.0/content.0")).toBe(listed.indexOf("b/message.0/content.0"));
    expect(listed.map((_, index) => keys.at(index))).toEqual(listed);
    expect(keys.indexOf("b/message.9/content.0")).toBeUndefined();
    expect(keys.indexOf("c/request")).toBeUndefined();
  });

  it("sizes a block by the characters of its content", () => {
    const { rows } = layout(shown)(createFormatter()(exchanges(request("a", body))));
    expect(rows.find(({ key }) => key === "a/message.0/content.0")).toMatchObject({ size: "Hello.".length });
    expect([999, 12_345, 999_949, 999_960, 2_500_000].map(describeSize)).toEqual(["999 chars", "12.3k chars", "999.9k chars", "1.0M chars", "2.5M chars"]);
    expect([999, 12_345, 999_960].map(compact)).toEqual(["999", "12.3k", "1.0M"]);
  });

  it("previews a block by the start of its first text or JSON, on one line, and prints a line's time and duration", () => {
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "  Hello.\n\nSecond   line" }] })).toBe("Hello. Second line");
    expect(preview({ category: "tools", name: "tool_use: Bash", parts: [{ kind: "fields", fields: [["id", "t1"]] }, { kind: "json", label: "input", value: { command: "ls -la" } }] })).toBe('{ "command": "ls -la" }');
    expect(preview({ category: "tools", name: "tool_result", parts: [{ kind: "fields", fields: [["tool_use_id", "t1"]] }] })).toBe("");
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "x".repeat(500) }] })).toBe(`${"x".repeat(200)}…`);
    expect(preview({ category: "user", name: "text", parts: [{ kind: "text", text: "x".repeat(200) }] })).toBe("x".repeat(200));
    expect(clockTime("2026-11-13T08:00:00.000Z")).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(seconds(2100)).toBe("2.1s");
  });

  it("lays an unchanged exchange out as the same rows", () => {
    const format = createFormatter();
    const layOut = layout(shown);
    const a = request("a", body);
    const first = layOut(format(exchanges(a)));
    const later = layOut(format(exchanges([...a, ...request("b", body)])));
    expect(later.rows.slice(0, first.rows.length)).toEqual(first.rows);
    first.rows.forEach((row, index) => expect(later.rows[index]).toBe(row));
  });

  it("is the layout before when no exchange's rows changed, as when only traffic the view does not show arrived", () => {
    const format = createFormatter();
    const layOut = layout(shown);
    const a = request("a", body);
    const first = layOut(format(exchanges(a)));
    expect(layOut(format(exchanges([...a, ...request("b", body).map((event) => ({ ...event, ...(event.type === "request" ? { url: "/v1/messages/count_tokens" } : {}) }))])))).toBe(first);
  });

  it("lays a changed exchange's unchanged groups out as the same rows, as a request's while its response arrives", () => {
    const format = createFormatter();
    const layOut = layout(shown);
    const a = request("a", body);
    const first = layOut(format(exchanges(a)));
    const later = layOut(format(exchanges([...a, { timestamp, trace_id: "a", type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [] }])));
    const requestRows = first.rows.filter(({ key }) => !key.startsWith("a/response") && key !== "a");
    requestRows.forEach((row) => expect(later.rows[later.keys.indexOf(row.key)!]).toBe(row));
    expect(later.rows[0]).not.toBe(first.rows[0]);
  });

  it("keeps the same keys while only what the rows show changes, as while a body arrives, and new ones when a row arrives", () => {
    const head: RecordedEvent = { timestamp, trace_id: "a", type: "response", status: 200, reason: "OK", http_version: "1.1", headers: [] };
    const chunk = (text: string): RecordedEvent => ({ timestamp, trace_id: "a", type: "response_body", base64: Buffer.from(text).toString("base64") });
    const format = createFormatter();
    const layOut = layout(shown);
    const a = [...request("a", body), head, chunk('{"type":')];
    const first = layOut(format(exchanges(a)));
    const later = layOut(format(exchanges([...a, chunk('"message"')])));
    expect(later.rows).not.toEqual(first.rows);
    expect(later.keys).toBe(first.keys);
    const more = layOut(format(exchanges([...a, chunk('"message"'), ...request("b", body)])));
    expect(more.keys).not.toBe(first.keys);
    expect(more.keys.at(more.rows.length - 1)).toBe(more.rows.at(-1)!.key);
  });

  it("leaves out a hidden category's blocks, and a group with none left, and keeps each exchange's line", () => {
    const withTools = { ...body, system: "Be brief.", tools: [{ name: "read" }] };
    const formatted = createFormatter()(exchanges(request("a", withTools)));
    const listed = (visibility: Record<Category, Visibility>) => layout(visibility)(formatted).rows.map(({ key }) => key);
    expect(listed(shown)).toEqual(["a", "a/request", "a/request/http", "a/request/parameters", "a/request/tools", "a/request/system.0", "a/message.0", "a/message.0/content.0"]);
    expect(listed({ ...shown, tools: "hidden" })).toEqual(["a", "a/request", "a/request/http", "a/request/parameters", "a/request/system.0", "a/message.0", "a/message.0/content.0"]);
    const dialogue = { ...shown, tools: "hidden", system: "hidden", metadata: "hidden", thinking: "hidden" } as const;
    const { rows, keys } = layout(dialogue)(formatted);
    expect(rows.map(({ key }) => key)).toEqual(["a", "a/message.0", "a/message.0/content.0"]);
    expect(keys.indexOf("a/message.0/content.0")).toBe(2);
    expect(listed({ ...dialogue, user: "hidden" })).toEqual(["a"]);
  });

  it("puts a row not listed at the row listed before it in its exchange, so it stays there as exchanges arrive", () => {
    const format = createFormatter();
    const dialogue = { ...shown, tools: "hidden", system: "hidden", metadata: "hidden", thinking: "hidden" } as const;
    const layOut = layout(dialogue);
    const a = request("a", { ...body, system: "Be brief." });
    const { keys } = layOut(format(exchanges(a)));
    expect(keys.at(keys.indexOf("a/request")!)).toBe("a");
    expect(keys.at(keys.indexOf("a/request/system.0")!)).toBe("a");
    const { keys: more } = layout({ ...dialogue, user: "hidden" })(format(exchanges([...a, ...request("b", body)])));
    expect(more.at(more.indexOf("a/message.0/content.0")!)).toBe("a");
    expect(more.at(more.indexOf("b/message.0/content.0")!)).toBe("b");
  });

  it("lists the same group and block rows whichever categories are hidden, so showing or hiding one sizes and renders no other", () => {
    const formatted = createFormatter()(exchanges(request("a", { ...body, system: "Be brief." })));
    const groupRows = createGroupRows();
    const all = createLayout(shown, groupRows)(formatted).rows;
    const some = createLayout({ ...shown, system: "hidden" }, groupRows)(formatted).rows;
    expect(some.length).toBe(all.length - 1);
    for (const row of some.filter(({ kind }) => kind !== "exchange")) expect(all).toContain(row);
  });
});
