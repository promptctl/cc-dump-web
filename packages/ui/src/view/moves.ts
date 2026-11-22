import { forkAbove } from "./forks.ts";
import { injectedFrom } from "./injected.ts";
import { presence, type At, type Position, type Presence } from "./position.ts";
import type { ForkRow, Keys, Row } from "./rows.ts";
import { adjacent, type Direction, type Found, type Match, type Step } from "./search.ts";

// The moves through the conversation (docs/design/02-design.md, "Keys"), each counting from the reader's place as the
// view's store holds it: what each would go to, decided apart from carrying it out (Conversation.tsx).

// What a move reads of the column: the rows listed and their keys, every row's keys, and whether the read can still
// bring a row not among them (rows.ts `unreadOf`).
export type Column = { layout: { rows: readonly Row[]; keys: Keys; every: { keys: Keys } }; unread: (key: string) => boolean };

// Where `position` stands among the rows listed, which the forks, the injected blocks and the scroll step count in.
export const inListed = ({ layout, unread }: Column, position: Position): Presence => presence(position, layout.keys, layout.every.keys.indexOf, unread);
// Where `position` stands among every row, which the search counts in.
const inEvery = ({ layout, unread }: Column, position: Position): Presence => presence(position, layout.every.keys, layout.every.keys.indexOf, unread);
// A match stands where its block's row does.
const matchAt = (column: Column, { key }: Match): Presence => inEvery(column, { at: "row", key, offset: 0 });

// Where a move counts from: the place's standing among the rows, or none, so no move, for a place not read yet, which
// the line says (waitingOf), or one nothing will bring, which the scroll step replaces in the commit that made it so.
const startOf = (standing: Presence): At | undefined => (standing.at === "unread" || standing.at === "gone" ? undefined : standing);

// The fork [ and ] switch at: the nearest above the reader's place.
export function forkMove(column: Column, position: Position): ForkRow | undefined {
  const at = startOf(inListed(column, position));
  return at === undefined ? undefined : forkAbove(column.layout.rows, at);
}

// The key of the injected block Alt+N and Alt+P go to: the one after or before the reader's place.
export function injectedMove(column: Column, position: Position, direction: Direction): string | undefined {
  const at = startOf(inListed(column, position));
  return at === undefined ? undefined : injectedFrom(column.layout.rows, at, direction);
}

// The step the search takes to the match after or before the current one, `current`, or, with none, the reader's
// place: none while either is not read yet or will not come.
export function matchMove(column: Column, found: Found, current: Match | undefined, position: Position, direction: Direction, pattern: RegExp): Step | undefined {
  const from = startOf(inEvery(column, position));
  if (from === undefined) return undefined;
  if (current === undefined) return adjacent(found, undefined, from, direction, pattern);
  const at = startOf(matchAt(column, current));
  return at === undefined ? undefined : adjacent(found, { match: current, at }, from, direction, pattern);
}

// What holds the moves, said by the line under the rows: the reader's place not read yet, or the current match not
// read yet, or nothing.
export type Waiting = "place" | "match" | undefined;

export function waitingOf(column: Column, position: Position, current: Match | undefined): Waiting {
  if (inListed(column, position).at === "unread") return "place";
  return current !== undefined && matchAt(column, current).at === "unread" ? "match" : undefined;
}

// Whether the current match is one nothing will bring, which the view then no longer holds as current.
export const matchGone = (column: Column, current: Match | undefined): boolean => current !== undefined && matchAt(column, current).at === "gone";
