// The lines a log keeps for the logs panel (docs/design/01-features.md, F9), importing nothing that needs node, so the
// UI keeps its own as a part's process keeps its (lines.ts).

// [LAW:single-enforcer] A log's last `keep` lines, numbered from 0 under `run`, an id of the process or page writing
// them, so a reader that comes back to the same writer goes on after the last line it read, and one that reaches a
// writer begun since reads it anew. A ring buffer: line `seq` is at `seq % keep` until `keep` more are written over it.
// Each reader `watch` adds is told as each line is written.
export function keptLines(keep: number) {
  const run = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const kept: string[] = [];
  let written = 0;
  const readers = new Set<() => void>();
  return {
    run,
    write: (line: string) => {
      kept[written++ % keep] = line;
      for (const told of readers) told();
    },
    // The first line still kept, and the number the next line written will have.
    first: () => Math.max(0, written - keep),
    written: () => written,
    // Line `seq`, while it is kept.
    line: (seq: number) => kept[seq % keep]!,
    // Tells `told` as each line is written, until the function it returns is called.
    watch: (told: () => void) => {
      readers.add(told);
      return () => void readers.delete(told);
    },
  };
}

export type KeptLines = ReturnType<typeof keptLines>;
