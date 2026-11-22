import { forkAbove } from "./forks.ts";
import { injectedFrom } from "./injected.ts";
import { presence, type At, type Position, type Presence } from "./position.ts";
import type { ForkRow, Gone, Layout, MomentStanding, Pending } from "./rows.ts";
import { adjacent, literal, resolve, type Current, type Direction, type Found, type Match, type Standing, type Step, type Unresolved } from "./search.ts";

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

// The step the search takes to the match after or before the one it counts from: the standing current match,
// `current`, or, with none, the reader's place. None while that is not read yet or will not come.
export function matchMove(column: ColumnState, found: Found, current: Standing | undefined, position: Position, direction: Direction, pattern: RegExp): Step | undefined {
  const at = startOf(current === undefined ? inEvery(column, position) : matchAt(column, current));
  return at === undefined ? undefined : adjacent(found, { match: current, at }, direction, pattern);
}

// What holds the moves, said by the line under the rows: the reader's place, or the current match, not read yet, by
// what can still bring it (`read`); none while nothing holds them.
export type Waiting = { held: "place" | "match"; read: Pending } | undefined;

export function waitingOf(column: ColumnState, position: Position, current: Standing | undefined): Waiting {
  const place = inListed(column, position);
  if (place.at === "pending") return { held: "place", read: place.read };
  const match = current === undefined ? undefined : matchAt(column, current);
  return match?.at === "pending" ? { held: "match", read: match.read } : undefined;
}

// A current match that is none, and why: nothing will bring its row (Gone), the search's pattern, `searching`, is now
// another than the one it was taken under (`pattern_changed`), or its text no longer holds it (search.ts `Unresolved`).
export type Cleared = Current & { why: Gone["why"] | "pattern_changed" | Unresolved; searching: string };

// The current match as the column's judge finds it: none is current; it stands; or it is cleared, with why.
export type Judged = { is: "none" } | { is: "standing"; match: Standing } | { is: "cleared"; cleared: Cleared };

// [LAW:single-enforcer] [LAW:parse-dont-validate] The one judge of the current match, and so the one maker of a
// standing one, run once for each render of the column: the counter, the highlight, the steps and the line under the
// rows take what it finds standing, and the view no longer holds as current what it clears. A match whose row is not
// read yet stands until it is.
export function judge(column: ColumnState, current: Current | undefined, pattern: RegExp): Judged {
  if (current === undefined) return { is: "none" };
  const why = whyCleared(column, current, pattern);
  return why === undefined ? { is: "standing", match: current as Standing } : { is: "cleared", cleared: { ...current, why, searching: literal(pattern) } };
}

// The match the judge found standing, the one every reader of the current match takes: none unless one stands.
export const currentOf = (judged: Judged): Standing | undefined => (judged.is === "standing" ? judged.match : undefined);

function whyCleared(column: ColumnState, current: Current, pattern: RegExp): Cleared["why"] | undefined {
  const standing = matchAt(column, current);
  if (standing.at === "gone") return standing.why;
  if (current.pattern !== literal(pattern)) return "pattern_changed";
  if (standing.at === "pending") return undefined;
  // A block not among the rows, as one the formatter replaced with another, shows none of its texts.
  if (standing.at !== "row") return "text_gone";
  const resolved = resolve(column.every.rows[standing.index]!, current, pattern);
  return resolved.resolved ? undefined : resolved.why;
}
