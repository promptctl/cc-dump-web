import { recordSource } from "./source.ts";

// [LAW:no-ambient-temporal-coupling] The proxy's source is recorded as node loads it, so the record begins before
// any other module of the proxy loads: they are imported only after, and have all loaded once the import resolves.
// A change to one of them shows a restart pending (status.ts) and takes effect only at that restart.
const recording = recordSource(import.meta.url);
const { run } = await import("./run.ts");
await run(recording.loaded());
