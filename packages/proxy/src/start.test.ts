import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { proxyProcess } from "./testing.ts";

describe("the reader port", () => {
  it("serves the recordings and the proxy's status, every answer to any origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const upstream = await serving((_req, res) => res.end());
    const { readerPort } = await proxyProcess(upstream.url, join(dir, "20261113T090000.000Z.jsonl"), "unlimited");
    const answers = await Promise.all(["/recordings", "/status", "/elsewhere"].map((path) => send(readerPort, { path })));
    expect(answers.map((res) => [res.statusCode, res.headers["content-type"], res.headers["access-control-allow-origin"]])).toEqual([
      [200, "application/json", "*"],
      [200, "text/event-stream", "*"],
      [404, undefined, "*"],
    ]);
    for (const res of answers) res.destroy();
  });
});
