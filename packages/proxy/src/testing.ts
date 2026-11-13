import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Event } from "@cc-dump/log";
import { eventLog } from "@cc-dump/log/testing";
import { onTestFinished } from "vitest";

const script = `
  import { createLog, serve, shutdownOnSignal } from ${JSON.stringify(new URL("../../log/src/index.ts", import.meta.url).href)};
  import { createProxy } from ${JSON.stringify(new URL("./proxy.ts", import.meta.url).href)};
  import { createReader } from ${JSON.stringify(new URL("./reading.ts", import.meta.url).href)};
  import { createRecording } from ${JSON.stringify(new URL("./recording.ts", import.meta.url).href)};
  const [upstream, path] = process.argv.slice(1);
  const log = createLog("proxy", (line) => process.stdout.write(line));
  const recording = createRecording(log, path);
  shutdownOnSignal(log, [
    await serve(log, createProxy(new URL(upstream), recording.record), 0),
    await serve(log, createReader(log, recording), 0),
  ]);
`;

// The proxy and its reader as their own process, wired as main.ts wires them, killed when the test finishes,
// recording to `path` under the shell's file size limit (`ulimit -f`: a count of blocks, or "unlimited"). Node
// ignores SIGXFSZ, so a write past the limit fails with EFBIG instead of killing the process. Its log is its
// stdout: `next()` resolves with each event after the two `listen` events the ports are read from.
export async function proxyProcess(upstream: string, path: string, fileSizeLimit: string) {
  const args = ["-c", 'ulimit -f "$1" && shift && exec "$@"', "sh", fileSizeLimit, process.execPath, "--input-type=module", "-e", script, upstream, path];
  const child = spawn("/bin/sh", args, { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  const { log, next } = eventLog();
  createInterface(child.stdout).on("line", (line) => log(JSON.parse(line) as Event));
  const [proxyPort, readerPort] = [(await next()).port, (await next()).port] as [number, number];
  return { child, proxyPort, readerPort, next };
}
