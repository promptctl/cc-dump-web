import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@cc-dump/log";
import { eventLog, send, serving } from "@cc-dump/log/testing";
import { describe, expect, it, onTestFinished } from "vitest";
import { parseProxyStatus, parseReadFailure } from "./format.ts";
import { sha256 } from "./source.ts";
import { createStatus, watchSource, type SourceState, type SourceWatch } from "./status.ts";

// Two source files in a directory of their own, recorded as they are now.
function sourceFiles() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cc-dump-status-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const [first, second] = [join(dir, "first.ts"), join(dir, "second.ts")];
  writeFileSync(first, "export const first = 1;\n");
  writeFileSync(second, "export const second = 2;\n");
  return { dir, first, second, source: new Map([first, second].map((path) => [path, sha256(readFileSync(path))])) };
}

// A watch whose states the test waits on: `next()` resolves with each state it changes to. Resolves once the watch
// is live: fs.watch's FSEvents stream on macOS starts after `watch` returns, and an edit before then is not seen, so a
// probe file is written beside the source until an event of it has run a check.
async function watching(source: Map<string, string>, dir: string) {
  const { log, next: nextEvent } = eventLog();
  const logged: Event[] = [];
  const watch = watchSource((event) => (logged.push(event), log(event)), source);
  const states: SourceState[] = [];
  const waiting: ((state: SourceState) => void)[] = [];
  onTestFinished(watch.onChanged(() => (waiting.length ? waiting.shift()!(watch.state()) : states.push(watch.state()))));
  expect([await nextEvent(), await nextEvent()]).toMatchObject([{ event: "watch_source" }, { event: "source_check" }]);
  const checked = nextEvent();
  for (let live = false; !live; ) {
    writeFileSync(join(dir, "probe"), "");
    live = await Promise.race([checked.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))]);
  }
  logged.length = 0;
  return { watch, logged, next: () => new Promise<SourceState>((resolve) => (states.length ? resolve(states.shift()!) : waiting.push(resolve))) };
}

describe("watchSource", () => {
  it("starts watching with nothing changed, and says so", () => {
    const { source } = sourceFiles();
    const logged: Event[] = [];
    const watch = watchSource((event) => void logged.push(event), source);
    expect(watch.state()).toEqual({ state: "watching", changed: [] });
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
    expect(await next()).toEqual({ state: "watching", changed: [first] });
    writeFileSync(first, original);
    expect(await next()).toEqual({ state: "watching", changed: [] });
    unlinkSync(second);
    expect(await next()).toEqual({ state: "watching", changed: [second] });
  });

  it("fails, and says so, when a file cannot be checked", () => {
    const { dir, source } = sourceFiles();
    const unreadable = join(dir, "unreadable");
    mkdirSync(unreadable);
    const logged: Event[] = [];
    const watch = watchSource((event) => void logged.push(event), new Map([...source, [unreadable, "0"]]));
    expect(watch.state()).toMatchObject({ state: "failed", error: { code: "EISDIR" } });
    expect(logged.at(-1)).toMatchObject({ event: "source_check", outcome: "error", error: expect.stringContaining("EISDIR") });
  });
});

// A watch the test sets the state of.
function fakeWatch(initial: SourceState) {
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
    become: (next: SourceState) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

// The Server-Sent Events of a response, as they arrive: `next()` resolves with each, or with "closed" at the end.
function events(res: IncomingMessage) {
  const arrived: ({ event: string; data: string } | "closed")[] = [];
  const waiting: ((arrival: (typeof arrived)[number]) => void)[] = [];
  const arrive = (arrival: (typeof arrived)[number]) => (waiting.length ? waiting.shift()!(arrival) : arrived.push(arrival));
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    text += chunk;
    for (let end = text.indexOf("\n\n"); end !== -1; end = text.indexOf("\n\n")) {
      const lines = text.slice(0, end).split("\n");
      text = text.slice(end + 2);
      const field = (name: string) => lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      arrive({ event: field("event") ?? "message", data: field("data") ?? "" });
    }
  });
  res.on("end", () => arrive("closed"));
  return () => new Promise<(typeof arrived)[number]>((resolve) => (arrived.length ? resolve(arrived.shift()!) : waiting.push(resolve)));
}

describe("GET /status", () => {
  it("sends the status now, then at each change, until the reader leaves", async () => {
    const { watch, become, listeners } = fakeWatch({ state: "watching", changed: [] });
    const { port, next } = await serving(createStatus(watch));
    const res = await send(port, { path: "/status" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const nextEvent = events(res);
    const status = async () => {
      const arrival = await nextEvent();
      if (arrival === "closed") throw new Error("the stream closed");
      expect(arrival.event).toBe("message");
      return parseProxyStatus(arrival.data);
    };
    expect(await status()).toEqual({ changed_source: [] });
    become({ state: "watching", changed: ["/src/proxy.ts"] });
    expect(await status()).toEqual({ changed_source: ["/src/proxy.ts"] });
    res.destroy();
    expect(await next()).toMatchObject({ event: "request", outcome: "aborted", url: "/status", status: 200 });
    expect(listeners.size).toBe(0);
  });

  it("ends the stream with a failed event when the watch fails, and fails the request with its error", async () => {
    const { watch, become, listeners } = fakeWatch({ state: "watching", changed: [] });
    const { port, next } = await serving(createStatus(watch));
    const nextEvent = events(await send(port, { path: "/status" }));
    expect(await nextEvent()).toEqual({ event: "message", data: JSON.stringify({ changed_source: [] }) });
    become({ state: "failed", error: new Error("EMFILE: too many open files, watch") });
    const failed = await nextEvent();
    expect(failed).toMatchObject({ event: "failed" });
    expect(parseReadFailure((failed as { data: string }).data)).toEqual({ message: "EMFILE: too many open files, watch" });
    expect(await nextEvent()).toBe("closed");
    expect(await next()).toMatchObject({ event: "request", outcome: "error", error: expect.stringContaining("EMFILE"), status: 200 });
    expect(listeners.size).toBe(0);
  });

  it("ends at once with a failed event when the watch has already failed", async () => {
    const { watch } = fakeWatch({ state: "failed", error: new Error("EISDIR: illegal operation on a directory, read") });
    const { port } = await serving(createStatus(watch));
    const nextEvent = events(await send(port, { path: "/status" }));
    expect(await nextEvent()).toMatchObject({ event: "failed", data: JSON.stringify({ message: "EISDIR: illegal operation on a directory, read" }) });
    expect(await nextEvent()).toBe("closed");
  });

  it("refuses a method other than GET", async () => {
    const { watch } = fakeWatch({ state: "watching", changed: [] });
    const { port } = await serving(createStatus(watch));
    const res = await send(port, { method: "POST", path: "/status", headers: { "content-length": "0" } });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET");
    res.resume();
  });
});
