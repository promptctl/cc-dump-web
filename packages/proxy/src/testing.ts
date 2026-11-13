import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Event } from "@cc-dump/log";
import { arrivals, eventLog, send } from "@cc-dump/log/testing";
import { expect, onTestFinished } from "vitest";

export type ServerSentEvent = { id?: string; event?: string; data: string };

// A Server-Sent Events client of the reader port: `next()` resolves with each event as it arrives.
export async function subscribe(port: number, path: string, headers: Record<string, string> = {}) {
  const res = await send(port, { path, headers });
  const { arrive, next } = arrivals<ServerSentEvent>();
  let text = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    text += chunk;
    for (let at = text.indexOf("\n\n"); at !== -1; at = text.indexOf("\n\n")) {
      const fields = text
        .slice(0, at)
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]);
      text = text.slice(at + 2);
      arrive({ data: "", ...Object.fromEntries(fields) } as ServerSentEvent);
    }
  });
  const take = async (n: number) => {
    const events: ServerSentEvent[] = [];
    while (events.length < n) events.push(await next());
    return events;
  };
  return { res, next, take };
}

// Built as main.ts builds the proxy: its source recorded before the rest of it loads, then `startProxy`.
const script = `
  import { recordSource } from ${JSON.stringify(new URL("./source.ts", import.meta.url).href)};
  const recordingSource = recordSource();
  const { createLog, shutdownOnSignal } = await import(${JSON.stringify(new URL("../../log/src/index.ts", import.meta.url).href)});
  const { createRecording } = await import(${JSON.stringify(new URL("./recording.ts", import.meta.url).href)});
  const { startProxy } = await import(${JSON.stringify(new URL("./start.ts", import.meta.url).href)});
  const [upstream, path] = process.argv.slice(1);
  const log = createLog("proxy", (line) => process.stdout.write(line));
  const recording = createRecording(log, path);
  const source = recordingSource.loaded();
  shutdownOnSignal(log, await startProxy(log, { upstream: new URL(upstream), recording, source, proxyPort: 0, readerPort: 0 }));
`;

// The proxy and its reader as their own process, served as main.ts serves them, killed when the test finishes,
// recording to `path` under the shell's file size limit (`ulimit -f`: a count of blocks, or "unlimited"). Node
// ignores SIGXFSZ, so a write past the limit fails with EFBIG instead of killing the process. Its log is its
// stdout: `next()` resolves with each event after its start: the watch of its source, which finds it unchanged, then
// the two `listen` events the ports are read from. The watch's later checks are not the test's: the source it watches
// is the repo's, and a save to it while the test runs is a check the test did not cause.
export async function proxyProcess(upstream: string, path: string, fileSizeLimit: string) {
  const args = ["-c", 'ulimit -f "$1" && shift && exec "$@"', "sh", fileSizeLimit, process.execPath, "--input-type=module", "-e", script, upstream, path];
  const child = spawn("/bin/sh", args, { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  const { log, next } = eventLog();
  let checks = 0;
  createInterface(child.stdout).on("line", (line) => {
    const event = JSON.parse(line) as Event;
    if (event.event !== "source_check" || checks++ === 0) log(event);
  });
  const started = [await next(), await next(), await next(), await next()];
  expect(started).toMatchObject([
    { event: "watch_source", outcome: "ok" },
    { event: "source_check", outcome: "ok", changed_source: [] },
    { event: "listen" },
    { event: "listen" },
  ]);
  const [proxyPort, readerPort] = started.slice(2).map(({ port }) => port) as [number, number];
  return { child, proxyPort, readerPort, next };
}
