import { parseLogLine } from "@cc-dump/log/line";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogRow } from "./LogsPanel.tsx";

// The texts a row's summary line shows after its time and part, each element's own, as it is rendered, for the event
// logged as `event`.
function rowSays(event: object): string[] {
  const line = parseLogLine(JSON.stringify({ service: "proxy", event: "request", trace_id: "t", started_at: "2026-11-16T09:00:00.000Z", duration_ms: 1, ...event }), "ab12:0");
  const html = renderToStaticMarkup(<LogRow listed={{ part: "proxy", line, ended: 0 }} restarted={false} />);
  const summary = /<summary[^>]*>(.*)<\/summary>/.exec(html)![1]!;
  return summary
    .split(/<[^>]+>/)
    .filter((text) => text !== "")
    .slice(2);
}

describe("a log row", () => {
  it("says a failed request's error, its first line, and then the facts that tell it from another", () => {
    expect(rowSays({ outcome: "error", error: "404 Not Found\n    at answered", method: "GET", url: "/elsewhere", status: 404 })).toEqual(["error", "request", "404 Not Found", "method=GET url=/elsewhere status=404"]);
  });

  it("says an event that ended as it should by its facts, its trace's id left to the event opened", () => {
    expect(rowSays({ outcome: "ok", url: "/logs", status: 200 })).toEqual(["info", "request", "url=/logs status=200"]);
  });
});
