import { recordSource } from "./source.ts";

// The proxy as main.ts runs it, but told everything on its command line instead of reading settings, so it runs beside
// a proxy that holds the fixed ports, and on ports of 0 for the tests:
//   node packages/proxy/src/isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>
// `run-start`, a UTC time like 2026-11-13T09:00:00Z, names the run's recording as main.ts names it for its start.
// [LAW:no-ambient-temporal-coupling] Its source is recorded before the rest of the proxy loads, as main.ts records it.
const recording = recordSource(import.meta.url);
const { createLog, logged, shutdownOnSignal } = await import("@cc-dump/log");
const { runRecordingName } = await import("./format.ts");
const { createRecordings } = await import("./recordings.ts");
const { startProxy } = await import("./start.ts");
const { parseUpstream } = await import("./proxy.ts");

// [LAW:parse-dont-validate] Each argument becomes what the proxy takes, or the process fails naming it.
function parseArguments([upstream, dir, runStart, proxyPort, readerPort, ...rest]: string[]) {
  if (readerPort === undefined || rest.length > 0) throw new Error("usage: isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(runStart!)) throw new Error(`run-start must be a UTC time like 2026-11-13T09:00:00Z, got ${JSON.stringify(runStart)}`);
  const port = (text: string) => {
    if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) throw new Error(`a port must be an integer from 0 to 65535, got ${JSON.stringify(text)}`);
    return Number(text);
  };
  return { upstream: parseUpstream(upstream), dir: dir!, run: runRecordingName(new Date(runStart!)), proxyPort: port(proxyPort!), readerPort: port(readerPort) };
}

const log = createLog("proxy", (line) => process.stdout.write(line));
// [LAW:nothing-unseen] Its `arguments` event says where it forwards and records, as main.ts's settings and recordings say.
const { upstream, dir, run, proxyPort, readerPort } = logged(log, "arguments", { argv: process.argv.slice(2) }, () => parseArguments(process.argv.slice(2)), (parsed) => parsed);
const recordings = createRecordings(log, dir, run);
shutdownOnSignal(log, await startProxy(log, { upstream, recordings, source: recording.loaded(), proxyPort, readerPort }));
