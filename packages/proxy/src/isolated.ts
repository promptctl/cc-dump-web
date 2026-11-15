import { recordSource } from "./source.ts";

// The proxy as main.ts runs it, but told everything on its command line instead of reading settings, so it runs beside
// a proxy that holds the fixed ports, and on ports of 0 for the tests:
//   node packages/proxy/src/isolated.ts <upstream> <recordings-dir> <run-recording-name> <proxy-port> <reader-port>
// [LAW:no-ambient-temporal-coupling] Its source is recorded before the rest of the proxy loads, as main.ts records it.
const recording = recordSource(import.meta.url);
const { createLog, shutdownOnSignal } = await import("@cc-dump/log");
const { createRecordings } = await import("./recordings.ts");
const { startProxy } = await import("./start.ts");
const { parseUpstream } = await import("./proxy.ts");
const [upstream, dir, run, proxyPort, readerPort] = process.argv.slice(2);
if (readerPort === undefined) {
  console.error("usage: isolated.ts <upstream> <recordings-dir> <run-recording-name> <proxy-port> <reader-port>");
  process.exit(2);
}
const log = createLog("proxy", (line) => process.stdout.write(line));
const recordings = createRecordings(log, dir!, run!);
const source = recording.loaded();
shutdownOnSignal(log, await startProxy(log, { upstream: parseUpstream(upstream), recordings, source, proxyPort: Number(proxyPort), readerPort: Number(readerPort) }));
