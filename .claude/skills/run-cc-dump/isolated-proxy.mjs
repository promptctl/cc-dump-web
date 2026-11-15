#!/usr/bin/env node
// The proxy alone, composed as packages/proxy/src/testing.ts composes it, on ports of your choosing, so it runs beside
// a cc-dump that already holds 3344-3347. No UI or server: read what it records from the recordings directory.
//   node .claude/skills/run-cc-dump/isolated-proxy.mjs <upstream> <recordings-dir> [proxy-port] [reader-port]
//   e.g. node .claude/skills/run-cc-dump/isolated-proxy.mjs http://127.0.0.1:3399 /tmp/ccd-iso/rec 3390 3391
// It runs the worktree's own proxy source, the one this skill sits in.
const [upstream, dir, proxyPort = "3390", readerPort = "3391"] = process.argv.slice(2);
if (!upstream || !dir) {
  console.error("usage: isolated-proxy.mjs <upstream> <recordings-dir> [proxy-port] [reader-port]");
  process.exit(2);
}
const src = new URL("../../../packages/", import.meta.url);
// The source is recorded before the rest of the proxy loads, as main.ts does.
const { recordSource } = await import(new URL("proxy/src/source.ts", src).href);
const source = recordSource();
const { createLog, shutdownOnSignal } = await import(new URL("log/src/index.ts", src).href);
const { createRecordings } = await import(new URL("proxy/src/recordings.ts", src).href);
const { runRecordingName } = await import(new URL("proxy/src/format.ts", src).href);
const { startProxy } = await import(new URL("proxy/src/start.ts", src).href);
const { parseUpstream } = await import(new URL("proxy/src/proxy.ts", src).href);
const log = createLog("proxy", (line) => process.stdout.write(line));
const recordings = createRecordings(log, dir, runRecordingName(new Date()));
shutdownOnSignal(log, await startProxy(log, { upstream: parseUpstream(upstream), recordings, source: source.loaded(), proxyPort: Number(proxyPort), readerPort: Number(readerPort) }));
