import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ending, Event } from "@cc-dump/log";
import { arrivals, eventLog, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxyStatus, type SourceStatus, type Traffic } from "./format.ts";
import { fileHash } from "./source.ts";
import { countTraffic, createStatus, watchable, watchSource } from "./status.ts";
import { subscribe } from "@cc-dump/log/testing";
import { parseTraceId } from "@cc-dump/log/trace";

// Two source files in a directory of their own, recorded as they are now.
function sourceFiles() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-dump-status-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const [first, second] = [join(dir, "first.ts"), join(dir, "second.ts")];
  writeFileSync(first, "export const first = 1;\n");
  writeFileSync(second, "export const second = 2;\n");
  return { dir, first, second, source: new Map([first, second].map((path) => [path, fileHash(path)])) };
}

// A watch whose states the test waits on: `next()` resolves with each state it changes to. Resolves once the watch
// is live: fs.watch's FSEvents stream on macOS starts after `watch` returns, and an edit before then is not seen, so a
// probe file is written beside the source until an event of it has run a check.
async function watching(source: Map<string, string>, dir: string) {
  const { log, next: nextEvent } = eventLog();
  const watch = watchSource(log, source);
  const { arrive, next } = arrivals<SourceStatus>();
  onTestFinished(watch.onChanged(() => arrive(watch.state())));
  expect([await nextEvent(), await nextEvent()]).toMatchObject([{ event: "watch_source" }, { event: "source_check" }]);
  const checked = nextEvent();
  for (let live = false; !live; ) {
    writeFileSync(join(dir, "probe"), "");
    live = await Promise.race([checked.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))]);
  }
  return { next };
}

describe("watchSource", () => {
  it("starts watching with nothing changed, and says so", () => {
    const { source } = sourceFiles();
    const logged: Event[] = [];
    const watch = watchSource((event) => void logged.push(event), source);
    expect(watch.state()).toEqual({ state: "watching", changed_source: [] });
    expect(logged).toMatchObject([
      { event: "watch_source", outcome: "ok", files: 2, directories: 1 },
      { event: "source_check", outcome: "ok", files_checked: 2, changed_source: [] },
    ]);
  });

  it("finds a file whose text changed, none once it is reverted, and a file deleted", async () => {
    const { dir, first, second, source } = sourceFiles();
    const { next } = await watching(source, dir);
    const original = readFileSync(first);
    writeFileSync(first, "export const first = 10;\n");
    expect(await next()).toEqual({ state: "watching", changed_source: [first] });
    writeFileSync(first, original);
    expect(await next()).toEqual({ state: "watching", changed_source: [] });
    unlinkSync(second);
    expect(await next()).toEqual({ state: "watching", changed_source: [second] });
  });

  it("fails, and says so, when a file cannot be checked", () => {
    const { dir, source } = sourceFiles();
    const unreadable = join(dir, "unreadable");
    mkdirSync(unreadable);
    const logged: Event[] = [];
    const watch = watchSource((event) => void logged.push(event), new Map([...source, [unreadable, "0"]]));
    expect(watch.state()).toEqual({ state: "failed", message: expect.stringContaining("EISDIR") });
    expect(logged.at(-1)).toMatchObject({ event: "source_check", outcome: "error", error: expect.stringContaining("EISDIR") });
  });
});

// A part of the proxy's state the test sets, and how many listen to it.
function watched<T>(initial: T) {
  const watch = watchable(initial);
  let listening = 0;
  const onChanged = (listener: () => void) => {
    listening++;
    const unwatch = watch.onChanged(listener);
    return () => {
      listening--;
      unwatch();
    };
  };
  return { ...watch, onChanged, listening: () => listening };
}

const quiet: Traffic = { in_flight: 0, last_request: null };

describe("countTraffic", () => {
  // A request the test ends: `end()` ends it as its response closing would.
  const request = (traffic: ReturnType<typeof countTraffic>) => {
    const { promise: ended, resolve } = Promise.withResolvers<Ending>();
    const handled: unknown[] = [];
    traffic.counted((req) => void handled.push(req))({} as IncomingMessage, {} as ServerResponse, { trace_id: parseTraceId("t"), fail: () => {}, ended });
    return { handled, end: () => resolve({ outcome: "ok" }) };
  };

  it("counts each request in flight from its arrival to its end, and when the latest arrived", async () => {
    const times = ["2026-11-16T10:00:00.000Z", "2026-11-16T10:00:05.000Z"];
    const traffic = countTraffic(() => new Date(times.shift()!));
    expect(traffic.state()).toEqual(quiet);

    const first = request(traffic);
    expect(first.handled).toHaveLength(1);
    expect(traffic.state()).toEqual({ in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" });
    const second = request(traffic);
    expect(traffic.state()).toEqual({ in_flight: 2, last_request: "2026-11-16T10:00:05.000Z" });

    first.end();
    await Promise.resolve();
    expect(traffic.state()).toEqual({ in_flight: 1, last_request: "2026-11-16T10:00:05.000Z" });
    second.end();
    await Promise.resolve();
    expect(traffic.state()).toEqual({ in_flight: 0, last_request: "2026-11-16T10:00:05.000Z" });
  });

  it("tells its listeners of each change", () => {
    const traffic = countTraffic(() => new Date("2026-11-16T10:00:00.000Z"));
    const seen: Traffic[] = [];
    traffic.onChanged(() => seen.push(traffic.state()));
    request(traffic);
    expect(seen).toEqual([{ in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" }]);
  });
});

describe("GET /status", () => {
  const info = { base_url: "http://127.0.0.1:3344", upstream: "https://api.anthropic.com/", recordings: "/recordings" };

  it("sends the proxy's info, the source's and the traffic's state now, then at each change of either, a failed watch's too, until the reader leaves", async () => {
    const source = watched<SourceStatus>({ state: "watching", changed_source: [] });
    const traffic = watched<Traffic>(quiet);
    const { port, next } = await serving(createStatus(info, source, traffic));
    const { res, next: nextEvent } = await subscribe(port, "/status");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const status = async () => {
      const event = await nextEvent();
      expect(event.event).toBeUndefined();
      return parseProxyStatus(event.data);
    };
    expect(await status()).toEqual({ info, source: { state: "watching", changed_source: [] }, traffic: quiet });
    source.become({ state: "watching", changed_source: ["/src/proxy.ts"] });
    expect(await status()).toEqual({ info, source: { state: "watching", changed_source: ["/src/proxy.ts"] }, traffic: quiet });
    traffic.become({ in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" });
    expect(await status()).toEqual({ info, source: { state: "watching", changed_source: ["/src/proxy.ts"] }, traffic: { in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" } });
    source.become({ state: "failed", message: "EMFILE: too many open files, watch" });
    expect(await status()).toEqual({ info, source: { state: "failed", message: "EMFILE: too many open files, watch" }, traffic: { in_flight: 1, last_request: "2026-11-16T10:00:00.000Z" } });
    expect(res.complete).toBe(false);
    res.destroy();
    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", url: "/status", status: 200 });
    expect([source.listening(), traffic.listening()]).toEqual([0, 0]);
  });

  it("refuses a method other than GET", async () => {
    const { port } = await serving(createStatus(info, watched<SourceStatus>({ state: "watching", changed_source: [] }), watched(quiet)));
    const res = await send(port, { method: "POST", path: "/status", headers: { "content-length": "0" } });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    res.resume();
  });
});
