import { forkAbove } from "./forks.ts";
import { injectedFrom } from "./injected.ts";
import { presence, type At, type Position, type Presence } from "./position.ts";
import type { BlockRow, ForkRow, Gone, Layout, MomentStanding, Pending } from "./rows.ts";
import { adjacent, inText, type Current, type Direction, type Found, type InText, type Match, type Step } from "./search.ts";

// The moves through the conversation (docs/design/02-design.md, "Keys"), each counting from the reader's place as the
// view's store holds it: what each would go to, decided apart from carrying it out (Conversation.tsx).

// What a move reads of the column: the rows listed and their keys, every row's keys, and how the moment it is of stands
// (rows.ts `standingOf`).
export type ColumnState = Pick<Layout, "rows" | "keys" | "every"> & { moment: MomentStanding };

// Where `position` stands among the rows listed, which the forks, the injected blocks and the scroll step count in.
export const inListed = ({ keys, every, moment }: ColumnState, position: Position): Presence => presence(position, keys, every.keys.indexOf, moment);
// Where `position` stands among every row, which the search counts in.
const inEvery = ({ every, moment }: ColumnState, position: Position): Presence => presence(position, every.keys, every.keys.indexOf, moment);
// A match stands where its block's row does.
const matchAt = (column: ColumnState, { key }: Match): Presence => inEvery(column, { at: "row", key, offset: 0 });

// Where a move counts from: the place's standing among the rows, or none, so no move, for a place not read yet, which
// the line says (waitingOf), or one nothing will bring, which the scroll step replaces in the commit that made it so.
const startOf = (standing: Presence): At | undefined => (standing.at === "pending" || standing.at === "gone" ? undefined : standing);

// The fork [ and ] switch at: the nearest above the reader's place.
export function forkMove(column: ColumnState, position: Position): ForkRow | undefined {
  const at = startOf(inListed(column, position));
  return at === undefined ? undefined : forkAbove(column.rows, at);
}

// The key of the injected block Alt+N and Alt+P go to: the one after or before the reader's place.
export function injectedMove(column: ColumnState, position: Position, direction: Direction): string | undefined {
  const at = startOf(inListed(column, position));
  return at === undefined ? undefined : injectedFrom(column.rows, at, direction);
}

// The step the search takes to the match after or before the one it counts from: the current match, `current`, while
// there is one, or else the reader's place. None while that is not read yet or will not come.
export function matchMove(column: ColumnState, found: Found, current: Match | undefined, position: Position, direction: Direction, pattern: RegExp): Step | undefined {
  const at = startOf(current === undefined ? inEvery(column, position) : matchAt(column, current));
  return at === undefined ? undefined : adjacent(found, { match: current, at }, direction, pattern);
}

// What holds the moves, said by the line under the rows: the reader's place, or the current match, not read yet, by
// what can still bring it (`read`); none while nothing holds them.
export type Waiting = { held: "place" | "match"; read: Pending } | undefined;

export function waitingOf(column: ColumnState, position: Position, current: Match | undefined): Waiting {
  const place = inListed(column, position);
  if (place.at === "pending") return { held: "place", read: place.read };
  const match = current === undefined ? undefined : matchAt(column, current);
  return match?.at === "pending" ? { held: "match", read: match.read } : undefined;
}

// [LAW:single-enforcer] The one judgement of where the current match stands as `column` shows it, against `before`, the
// column the view last judged it in, which the view takes at each commit and carries out: gone when the pattern is
// another than the one it is a match of, or when nothing will bring its row; judged in its text while its row is among
// every row (search.ts `inText`); and standing while its row is not read yet, which the line says, or while it stands
// in a row its own is inside, as a block the formatter replaced stands at its group, so the steps go on from where it
// was.
export type MatchStanding = InText | Gone<Gone["why"] | "pattern_changed">;

export function matchStanding(before: ColumnState, column: ColumnState, current: Current, pattern: RegExp): MatchStanding {
  if (current.pattern !== String(pattern)) return { at: "gone", why: "pattern_changed" };
  const at = matchAt(column, current);
  if (at.at === "gone") return at;
  const row = blockAt(column, at);
  return row === undefined ? { at: "standing" } : inText(current, blockAt(before, matchAt(before, current)) ?? row, row, pattern);
}

// The block's row a match stands at, while it stands at its own.
function blockAt({ every }: ColumnState, at: Presence): BlockRow | undefined {
  const row = at.at === "row" ? every.rows[at.index] : undefined;
  return row?.kind === "block" ? row : undefined;
}
