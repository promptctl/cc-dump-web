import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { LOOPBACK } from "@cc-dump/log/address";
import { send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxyInfo } from "./format.ts";
import { proxyProcess } from "./testing.ts";

describe("the reader port", () => {
  const proxy = async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const upstream = await serving((_req, res) => res.end());
    return proxyProcess(upstream.url, join(dir, "20261113T090000.000Z.jsonl"), "unlimited");
  };

  it("serves the recordings and the proxy's status and info, every answer to any origin", async () => {
    const { readerPort } = await proxy();
    const answers = await Promise.all(["/recordings", "/status", "/info", "/elsewhere"].map((path) => send(readerPort, { path })));
    expect(answers.map((res) => [res.statusCode, res.headers["content-type"], res.headers["access-control-allow-origin"]])).toEqual([
      [200, "application/json", "*"],
      [200, "text/event-stream", "*"],
      [200, "application/json", "*"],
      [404, undefined, "*"],
    ]);
    for (const res of answers) res.destroy();
  });

  it("gives agents the address of the port the proxy bound", async () => {
    const { proxyPort, readerPort } = await proxy();
    const res = await send(readerPort, { path: "/info" });
    expect(parseProxyInfo((await buffer(res)).toString())).toEqual({ base_url: `http://${LOOPBACK}:${proxyPort}` });
  });
});
