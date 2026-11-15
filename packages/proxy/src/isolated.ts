import { recordSource } from "./source.ts";

// The proxy as main.ts runs it, but told everything on its command line instead of reading settings, so it runs beside
// a proxy that holds the fixed ports, and on ports of 0 for the tests:
//   node packages/proxy/src/isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>
// `run-start`, an ISO 8601 time, names the run's recording as main.ts names it for the moment its run started.
// [LAW:no-ambient-temporal-coupling] Its source is recorded before the rest of the proxy loads, as main.ts records it.
const recording = recordSource(import.meta.url);
const { createLog, shutdownOnSignal } = await import("@cc-dump/log");
const { runRecordingName } = await import("./format.ts");
const { createRecordings } = await import("./recordings.ts");
const { startProxy } = await import("./start.ts");
const { parseUpstream } = await import("./proxy.ts");

// [LAW:parse-dont-validate] Each argument becomes what the proxy takes, or the process fails naming it.
const port = (text: string | undefined) => {
  const port = Number(text);
  if (text === "" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`port must be an integer from 0 to 65535, got ${JSON.stringify(text)}`);
  return port;
};
const [upstream, dir, runStart, proxyPort, readerPort] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>");
const start = new Date(runStart!);
if (Number.isNaN(start.getTime())) throw new Error(`run-start must be an ISO 8601 time, got ${JSON.stringify(runStart)}`);
const run = runRecordingName(start);
const ports = { proxyPort: port(proxyPort), readerPort: port(readerPort) };

const log = createLog("proxy", (line) => process.stdout.write(line));
const recordings = createRecordings(log, dir, run);
const source = recording.loaded();
shutdownOnSignal(log, await startProxy(log, { upstream: parseUpstream(upstream), recordings, source, ...ports }));
