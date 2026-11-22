import { conversationKeys, fieldKeys, withKeys } from "./keyboard.ts";
import type { Start } from "./position.ts";
import type { SearchStart } from "./search.ts";

const moves = [conversationKeys.previousSibling, conversationKeys.nextSibling, conversationKeys.nextInjected, conversationKeys.previousInjected];
const steps = [conversationKeys.next, conversationKeys.previous, fieldKeys.next, fieldKeys.previous];

// [LAW:no-silent-failure] What the line under the rows says while a move waits for its start to be read
// (docs/design/02-design.md, "Keys"): each start that waits, the reader's place or the current match, with the keys
// that wait on it, from `place` and `search` alone, the starts the moves are given; empty while none waits.
export function waitingLine(place: Start, search: SearchStart): string {
  const onPlace = search.at === "waiting" && search.on === "place" ? steps : [];
  const onMatch = search.at === "waiting" && search.on === "match" ? [withKeys("The match you were at is not read yet, so these wait for it", ...steps)] : [];
  const placeLine = place.at === "waiting" ? [withKeys("Your place is not read yet, so these wait for it", ...moves, ...onPlace)] : [];
  return [...placeLine, ...onMatch].join(". ");
}
