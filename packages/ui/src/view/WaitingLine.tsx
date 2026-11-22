import type { Waiting } from "./moves.ts";
import type { Pending } from "./rows.ts";

// What the line under the rows says holds the moves (moves.ts), by what can still bring the row: the read as it goes
// on, or, after it failed, the read begun when the recording is opened again.
const says: Record<Pending, Record<NonNullable<Waiting>["held"], string>> = {
  reading: { place: "Your place is not read yet", match: "The current match is not read yet" },
  failed: {
    place: "Your place was not read before the read failed: open the recording again to read on",
    match: "The current match was not read before the read failed: open the recording again to read on",
  },
};

// The line under the rows: a status, so a screen reader says it as it changes; empty while nothing holds the moves.
export function WaitingLine({ waiting }: { waiting: Waiting }) {
  return (
    <p role="status" className="rounded-full bg-panel px-3 py-1 text-xs text-foreground-muted empty:bg-transparent empty:p-0">
      {waiting === undefined ? null : says[waiting.read][waiting.held]}
    </p>
  );
}
