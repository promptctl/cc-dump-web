import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@cc-dump/log";
import { arrivals, eventLog, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxyStatus, type ProxyStatus } from "./format.ts";
import { fileHash } from "./source.ts";
import { createStatus, watchSource, type SourceWatch } from "./status.ts";
import { subscribe } from "./testing.ts";

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
  const { arrive, next } = arrivals<ProxyStatus>();
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

// A watch the test sets the state of.
function fakeWatch(initial: ProxyStatus) {
  let state = initial;
  const listeners = new Set<() => void>();
  const watch: SourceWatch = {
    state: () => state,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    watch,
    listeners,
    become: (next: ProxyStatus) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("GET /status", () => {
  it("sends the status now, then at each change, a failed watch's too, until the reader leaves", async () => {
    const { watch, become, listeners } = fakeWatch({ state: "watching", changed_source: [] });
    const { port, next } = await serving(createStatus(watch));
    const { res, next: nextEvent } = await subscribe(port, "/status");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const status = async () => {
      const event = await nextEvent();
      expect(event.event).toBeUndefined();
      return parseProxyStatus(event.data);
    };
    expect(await status()).toEqual({ state: "watching", changed_source: [] });
    become({ state: "watching", changed_source: ["/src/proxy.ts"] });
    expect(await status()).toEqual({ state: "watching", changed_source: ["/src/proxy.ts"] });
    become({ state: "failed", message: "EMFILE: too many open files, watch" });
    expect(await status()).toEqual({ state: "failed", message: "EMFILE: too many open files, watch" });
    expect(res.complete).toBe(false);
    res.destroy();
    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", url: "/status", status: 200 });
    expect(listeners.size).toBe(0);
  });

  it("refuses a method other than GET", async () => {
    const { watch } = fakeWatch({ state: "watching", changed_source: [] });
    const { port } = await serving(createStatus(watch));
    const res = await send(port, { method: "POST", path: "/status", headers: { "content-length": "0" } });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    res.resume();
  });
});
