import { recordSource } from "./source.ts";

// The proxy as main.ts runs it, but told everything on its command line instead of reading settings, so it runs beside
// a proxy that holds the fixed ports, and on ports of 0 for the tests:
//   node packages/proxy/src/isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>
// `run-start`, a UTC time like 2026-11-13T09:00:00Z, names the run's recording as main.ts names it for its start.
// [LAW:no-ambient-temporal-coupling] Its source is recorded before the rest of the proxy loads, as main.ts records it.
const recording = recordSource(import.meta.url);
const { logged, shutdownOnSignal } = await import("@cc-dump/log");
const { processLog } = await import("@cc-dump/log/lines");
const { runRecordingName } = await import("./format.ts");
const { createRecordings } = await import("./recordings.ts");
const { startProxy } = await import("./start.ts");
const { parseUpstream } = await import("./proxy.ts");
const { kinds, parse, parsed } = await import("@cc-dump/log/json");
const { Malformed } = await import("@cc-dump/log/failure");

// [LAW:parse-dont-validate] Each argument becomes what the proxy takes, or the process fails naming it.
function parseArguments(args: string[]) {
  if (args.length !== 5) throw new Error("usage: isolated.ts <upstream> <recordings-dir> <run-start> <proxy-port> <reader-port>");
  const [upstream, dir, runStart, proxyPort, readerPort] = args;
  const argument = <T>(name: string, text: string | undefined, as: (text: string) => T): T => parse(parsed(kinds.string, as), text, name);
  const port = (text: string) => {
    if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) throw new Malformed(`must be an integer from 0 to 65535, got ${JSON.stringify(text)}`);
    return Number(text);
  };
  // A time is one `Date` writes back as it was given, so a month or day out of range is refused, not rolled over.
  const runName = (text: string) => {
    const start = new Date(text);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(text) || Number.isNaN(start.getTime()) || !start.toISOString().startsWith(text.slice(0, 19)))
      throw new Malformed(`must be a UTC time like 2026-11-13T09:00:00Z, got ${JSON.stringify(text)}`);
    return runRecordingName(start);
  };
  const directory = (text: string) => {
    if (text === "") throw new Malformed("must name a directory");
    return text;
  };
  return {
    upstream: argument("upstream", upstream, parseUpstream),
    dir: argument("recordings-dir", dir, directory),
    run: argument("run-start", runStart, runName),
    proxyPort: argument("proxy-port", proxyPort, port),
    readerPort: argument("reader-port", readerPort, port),
  };
}
const { log, logs } = processLog("proxy");
// [LAW:nothing-unseen] Its `arguments` event says where it forwards and records, as main.ts's settings and recordings say.
const { upstream, dir, run, proxyPort, readerPort } = logged(log, "arguments", { argv: process.argv.slice(2) }, () => parseArguments(process.argv.slice(2)), (parsed) => parsed);
const recordings = createRecordings(log, dir, run);
shutdownOnSignal(log, await startProxy(log, { upstream, recordings, source: recording.loaded(), logs, proxyPort, readerPort }));
