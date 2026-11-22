import { forkAbove } from "./forks.ts";
import { injectedFrom } from "./injected.ts";
import { presence, type At, type Position, type Presence } from "./position.ts";
import type { ForkRow, Gone, Layout, MomentStanding, Pending } from "./rows.ts";
import { adjacent, ordinal, type Direction, type Found, type Match, type Step } from "./search.ts";

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

// A current match the view no longer holds, by its block's key, and why: nothing will bring its row, or its row is
// read and its text holds no match at its place (search.ts `Match`), as a tool's input so far once whole. A move in
// time leaves no match current (state.ts), and at now a text only grows, so nothing brings that match back either.
export type Cleared = { key: string; why: Gone["why"] | "text_changed" };

// [LAW:single-enforcer] The current match the view no longer holds, which the counter, the highlight and the steps
// then agree is none; none while it can still come, or none is current.
export function matchGone(column: ColumnState, found: Found, current: Match | undefined, pattern: RegExp): Cleared | undefined {
  if (current === undefined) return undefined;
  const at = matchAt(column, current);
  if (at.at === "gone") return { key: current.key, why: at.why };
  return at.at !== "pending" && ordinal(found, current, pattern) === undefined ? { key: current.key, why: "text_changed" } : undefined;
}
