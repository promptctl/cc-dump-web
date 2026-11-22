import type { Waiting } from "./moves.ts";

// What the line under the rows says holds the moves (moves.ts): true while the read goes on and after it failed, since
// either way the row is still to be read.
const says: Record<NonNullable<Waiting>, string> = {
  place: "Your place is not read yet",
  match: "The current match is not read yet",
};

// The line under the rows: a status, so a screen reader says it as it changes; empty while nothing holds the moves.
export function WaitingLine({ waiting }: { waiting: Waiting }) {
  return (
    <p role="status" className="rounded-full bg-panel px-3 py-1 text-xs text-foreground-muted empty:bg-transparent empty:p-0">
      {waiting === undefined ? null : says[waiting]}
    </p>
  );
}
