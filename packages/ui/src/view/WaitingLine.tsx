import type { Waiting } from "./moves.ts";
import type { Pending } from "./rows.ts";

// What the line under the rows says holds the moves (moves.ts), by what can still bring the row: the read as it goes
// on, or, after it failed, a new read.
const says: Record<Pending, Record<NonNullable<Waiting>["held"], string>> = {
  reading: { place: "Your place is not read yet", match: "The current match is not read yet" },
  failed: { place: "The read failed before your place", match: "The read failed before the current match" },
};

// The line under the rows: a status, so a screen reader says it as it changes; empty while nothing holds the moves.
export function WaitingLine({ waiting }: { waiting: Waiting }) {
  return (
    <p role="status" className="rounded-full bg-panel px-3 py-1 text-xs text-foreground-muted empty:bg-transparent empty:p-0">
      {waiting === undefined ? null : says[waiting.read][waiting.held]}
    </p>
  );
}
