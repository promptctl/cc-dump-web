import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { onTestFinished } from "vitest";

const script = `
  import { serve } from ${JSON.stringify(new URL("../../log/src/index.ts", import.meta.url).href)};
  import { createProxy } from ${JSON.stringify(new URL("./proxy.ts", import.meta.url).href)};
  import { createReader } from ${JSON.stringify(new URL("./reading.ts", import.meta.url).href)};
  import { createRecording } from ${JSON.stringify(new URL("./recording.ts", import.meta.url).href)};
  const [upstream, path] = process.argv.slice(1);
  const ignore = () => {};
  const recording = createRecording(ignore, path);
  const proxy = await serve(ignore, createProxy(new URL(upstream), recording.record), 0);
  const reader = await serve(ignore, createReader(ignore, recording), 0);
  process.stdout.write(proxy.port + " " + reader.port + "\\n");
`;

// The proxy and its reader as their own process, killed when the test finishes, recording to `path` under
// the shell's file size limit (`ulimit -f`: a count of blocks, or "unlimited"). Node ignores SIGXFSZ, so a
// write past the limit fails with EFBIG instead of killing the process.
export async function proxyProcess(upstream: string, path: string, fileSizeLimit: string) {
  const args = ["-c", 'ulimit -f "$1" && shift && exec "$@"', "sh", fileSizeLimit, process.execPath, "--input-type=module", "-e", script, upstream, path];
  const child = spawn("/bin/sh", args, { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => void child.kill("SIGKILL"));
  const [line] = (await once(createInterface(child.stdout), "line")) as [string];
  const [proxyPort, readerPort] = line.split(" ").map(Number) as [number, number];
  return { child, proxyPort, readerPort };
}
