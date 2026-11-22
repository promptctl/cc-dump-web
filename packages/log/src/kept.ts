// The lines a log keeps for the logs panel (docs/design/01-features.md, F9), importing nothing that needs node, so the
// UI keeps its own as a part's process keeps its (lines.ts).
import type { LinePosition } from "./line.ts";
import { randomHex } from "./trace.ts";

// A line kept, as a reader is handed it: where it is, and its text, without its newline.
export type KeptLine = { position: LinePosition; line: string };

// [LAW:single-enforcer] A log's last `keep` lines, numbered from 0 under `run`, an id of the process or page writing
// them, so a reader that comes back to the same writer goes on after the last line it read, and one that reaches a
// writer begun since reads it anew. A ring buffer: line `seq` is at `seq % keep` until `keep` more are written over it.
// Each reader `watch` adds is told as each line is written.
export function keptLines(keep: number) {
  const run = randomHex(8);
  const kept: string[] = [];
  let written = 0;
  const readers = new Set<() => void>();
  return {
    run,
    write: (line: string) => {
      kept[written++ % keep] = line;
      for (const told of readers) told();
    },
    // [LAW:single-enforcer] A reader's place among the lines, from line `seq` on: each call hands the next line still
    // kept, or undefined once every line written has been handed. A line let go before it is handed is passed over, so
    // the reader sees the gap in the numbers.
    from: (seq: number) => {
      let next = seq;
      return (): KeptLine | undefined => {
        next = Math.max(next, written - keep);
        if (next >= written) return undefined;
        const at = next++;
        return { position: { run, seq: at }, line: kept[at % keep]!.trimEnd() };
      };
    },
    // Tells `told` as each line is written, until the function it returns is called.
    watch: (told: () => void) => {
      readers.add(told);
      return () => void readers.delete(told);
    },
  };
}
