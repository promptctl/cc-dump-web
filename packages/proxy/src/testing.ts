import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Event } from "@cc-dump/log";
import { eventLog } from "@cc-dump/log/testing";
import { expect, onTestFinished } from "vitest";
import { runRecordingName } from "./format.ts";

// The name of the run's recording in a proxy process: the traffic no agent claims is recorded there.
const runStart = "2026-11-13T09:00:00.000Z";
export const runName = runRecordingName(new Date(runStart));

// The proxy and its reader as their own process, isolated.ts on ports of 0, killed when the test finishes,
// recording into `dir` under the shell's file size limit (`ulimit -f`: a count of blocks, or "unlimited"). Node
// ignores SIGXFSZ, so a write past the limit fails with EFBIG instead of killing the process. Its log is its
// stdout: `next()` resolves with each event after its start: its arguments, the watch of its source and its first check, then the two
// `listen` events the ports are read from. What the checks find is not the test's: the source watched is the repo's,
// and a save to it while the test runs is a change the test did not cause, so only the start-up check and a check that
// fails reach the test.
export async function proxyProcess(upstream: string, dir: string, fileSizeLimit: string) {
  const args = ["-c", 'ulimit -f "$1" && shift && exec "$@"', "sh", fileSizeLimit, process.execPath, fileURLToPath(new URL("./isolated.ts", import.meta.url)), upstream, dir, runStart, "0", "0"];
  const child = spawn("/bin/sh", args, { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  const { log, next } = eventLog();
  let checks = 0;
  createInterface(child.stdout).on("line", (line) => {
    const event = JSON.parse(line) as Event;
    const saved = event.event === "source_check" && event.outcome === "ok" && checks++ > 0;
    if (!saved) log(event);
  });
  const started = [await next(), await next(), await next(), await next(), await next()];
  expect(started).toMatchObject([
    { event: "arguments", outcome: "ok", run: runName, dir },
    { event: "watch_source", outcome: "ok" },
    { event: "source_check", outcome: "ok" },
    { event: "listen" },
    { event: "listen" },
  ]);
  const [proxyPort, readerPort] = started.slice(3).map(({ bound_port }) => bound_port) as [number, number];
  return { child, proxyPort, readerPort, next };
}
