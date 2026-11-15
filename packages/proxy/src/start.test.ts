import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { LOOPBACK } from "@cc-dump/log/address";
import { send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseListing, parseListings, parseProxyInfo, recordingStart } from "./format.ts";
import { proxyProcess } from "./testing.ts";

describe("the reader port", () => {
  const proxy = async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const upstream = await serving((_req, res) => res.end());
    return { dir, ...(await proxyProcess(upstream.url, dir, "unlimited")) };
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

  it("makes a recording for an agent about to launch, answering its name, and lists it", async () => {
    const { dir, readerPort } = await proxy();

    const res = await send(readerPort, { method: "POST", path: "/recordings" });
    const { name } = parseListing((await buffer(res)).toString());

    expect([res.statusCode, res.headers["content-type"], res.headers["access-control-allow-origin"]]).toEqual([200, "application/json", "*"]);
    expect(recordingStart(name)).toBeInstanceOf(Date);
    expect(readFileSync(join(dir, name), "utf8")).toBe("");
    const listed = await send(readerPort, { path: "/recordings" });
    expect(parseListings((await buffer(listed)).toString())).toEqual([{ name }]);
  });

  it("makes each recording its own, though asked within one millisecond", async () => {
    const { readerPort } = await proxy();
    const names = await Promise.all(
      Array.from({ length: 5 }, async () => parseListing((await buffer(await send(readerPort, { method: "POST", path: "/recordings" }))).toString()).name),
    );
    expect(new Set(names).size).toBe(5);
  });

  it("refuses the other methods of the list, naming those it takes", async () => {
    const { readerPort } = await proxy();
    const res = await send(readerPort, { method: "PUT", path: "/recordings" });
    expect([res.statusCode, res.headers.allow]).toEqual([405, "GET, POST"]);
    res.destroy();
  });

  it("gives agents the address of the port the proxy bound", async () => {
    const { proxyPort, readerPort } = await proxy();
    const res = await send(readerPort, { path: "/info" });
    expect(parseProxyInfo((await buffer(res)).toString())).toEqual({ base_url: `http://${LOOPBACK}:${proxyPort}` });
  });
});
