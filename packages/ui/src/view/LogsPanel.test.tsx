import { parseLogLine } from "@cc-dump/log/line";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogRow } from "./LogsPanel.tsx";

// What a row's line says of the event logged as `event`, as it is rendered: its error's cell and its facts' cell.
function rowSays(event: object) {
  const line = parseLogLine(JSON.stringify({ service: "proxy", event: "request", trace_id: "t", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 1, ...event }), "ab12:0");
  const html = renderToStaticMarkup(<LogRow listed={{ part: "proxy", line, ended: 0 }} restarted={false} />);
  const cell = (name: string) => new RegExp(`<span data-log-${name}="[^"]*"[^>]*>([^<]*)</span>`).exec(html)?.[1];
  return { error: cell("error"), facts: cell("facts") };
}

describe("a log row", () => {
  it("says a failed request's error, its first line, and then the facts that tell it from another", () => {
    expect(rowSays({ outcome: "error", error: "404 Not Found\n    at refusal", method: "GET", url: "/elsewhere", status: 404 })).toEqual({ error: "404 Not Found", facts: "method=GET url=/elsewhere status=404" });
  });

  it("says a decision of the UI's by its facts, a place among them as it is stored, as the markup escapes it", () => {
    expect(rowSays({ service: "ui", event: "place_replaced", outcome: "ok", from: { at: "row", key: "t1/said", offset: 4 }, why: "read_ended" })).toEqual({
      error: undefined,
      facts: "from={&quot;at&quot;:&quot;row&quot;,&quot;key&quot;:&quot;t1/said&quot;,&quot;offset&quot;:4} why=read_ended",
    });
  });

  it("says an event that ended as it should by its facts, its trace's id left to the event opened", () => {
    expect(rowSays({ outcome: "ok", url: "/logs", status: 200 })).toEqual({ error: undefined, facts: "url=/logs status=200" });
  });
});
