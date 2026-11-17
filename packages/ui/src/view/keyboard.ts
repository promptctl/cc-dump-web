import { useEffect, useLayoutEffect, useRef } from "react";
import { categories, type Category } from "../format/blocks.ts";
import type { Direction } from "./search.ts";

// [LAW:one-source-of-truth] The keys (docs/design/02-design.md, "Keys"): each one's chord, what it does and its act, in
// one table. What hears a key, the keys panel and the controls' titles all read it, so none names a key another does not.

// A key: its `chord`, as it is written for a reader (chordOf); what it `does`, in the keys panel's words; whether it
// `repeats`, acting again and again while it is held, as a move does and a switch, which its next act would undo, does
// not; and its `act`, on what the place it is heard in offers its keys.
export type Key<Acts> = { chord: string; does: string; repeats: boolean; act: (acts: Acts) => void };

// What the search field offers its keys: a step of the search, and the cursor taken out of the field.
export type FieldActs = { match: (direction: Direction) => void; leave: () => void };

// What the conversation offers its keys: the cursor put in the search field; a step of the search; a scroll to an end of
// the conversation, or by lines of its text, down or, below zero, up; a step in time, back or forward; a move to the
// next or the previous block the harness injected; follow turned on or off; and a category moved to its next level.
export type ConversationActs = {
  search: () => void;
  match: (direction: Direction) => void;
  edge: (edge: Edge) => void;
  lines: (by: number) => void;
  inTime: (by: -1 | 1) => void;
  injected: (direction: Direction) => void;
  follow: () => void;
  level: (category: Category) => void;
};
export type Edge = "top" | "bottom";

// What the app offers its keys: the keys panel shown or put away.
export type AppActs = { help: () => void };

export const fieldKeys = {
  next: { chord: "Enter", does: "The next match", repeats: true, act: (acts) => acts.match("next") },
  previous: { chord: "Shift+Enter", does: "The previous match", repeats: true, act: (acts) => acts.match("previous") },
  // As the original's Escape: the search stays as it is, so n and N go on among its matches.
  leave: { chord: "Esc", does: "Leave the field, keeping the search", repeats: false, act: (acts) => acts.leave() },
} satisfies Record<string, Key<FieldActs>>;

export const conversationKeys = {
  search: { chord: "/", does: "Search: the cursor goes to the search field", repeats: false, act: (acts) => acts.search() },
  next: { chord: "n", does: "The next match", repeats: true, act: (acts) => acts.match("next") },
  previous: { chord: "N", does: "The previous match", repeats: true, act: (acts) => acts.match("previous") },
  top: { chord: "g", does: "The top of the conversation", repeats: false, act: (acts) => acts.edge("top") },
  bottom: { chord: "G", does: "The bottom of the conversation", repeats: false, act: (acts) => acts.edge("bottom") },
  down: { chord: "j", does: "Down a line", repeats: true, act: (acts) => acts.lines(1) },
  up: { chord: "k", does: "Up a line", repeats: true, act: (acts) => acts.lines(-1) },
  back: { chord: "←", does: "The step before", repeats: true, act: (acts) => acts.inTime(-1) },
  forward: { chord: "→", does: "The step after", repeats: true, act: (acts) => acts.inTime(1) },
  nextInjected: { chord: "Alt+N", does: "The next block the harness injected", repeats: true, act: (acts) => acts.injected("next") },
  previousInjected: { chord: "Alt+P", does: "The previous block the harness injected", repeats: true, act: (acts) => acts.injected("previous") },
  follow: { chord: "f", does: "Follow the newest content, or stop following", repeats: false, act: (acts) => acts.follow() },
} satisfies Record<string, Key<ConversationActs>>;

// A category's key, the digit of its place in the filter bar, which lists `categories` in their order.
export const levelKeys = Object.fromEntries(
  categories.map((category, index) => [
    category,
    { chord: `${index + 1}`, does: `${category}: its next level of detail`, repeats: false, act: (acts: ConversationActs) => acts.level(category) },
  ]),
) as Record<Category, Key<ConversationActs>>;

export const appKeys = {
  help: { chord: "?", does: "Show these keys, or put them away", repeats: false, act: (acts) => acts.help() },
} satisfies Record<string, Key<AppActs>>;

// Every key, by the place it is heard in and that place's name: what each place presses, and what the keys panel lists.
export const heard = {
  conversation: { where: "The conversation", keys: [...Object.values<Key<ConversationActs>>(conversationKeys), ...Object.values(levelKeys)] },
  field: { where: "The search field", keys: Object.values<Key<FieldActs>>(fieldKeys) },
  app: { where: "Anywhere", keys: Object.values<Key<AppActs>>(appKeys) },
} as const;

// What a press reads of a keydown event.
export type Pressed = Pick<KeyboardEvent, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing" | "keyCode" | "defaultPrevented" | "target" | "preventDefault">;

// How the table writes a key that types no character and whose own name is longer.
const written: Partial<Record<string, string>> = { ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

// The chord a press says, as the table writes one: the character the key types (`n`, `N`, `?`), or its name (`Enter`,
// `←`), after each of Ctrl, Meta, Alt and Shift held with it. With Alt a key types another character, or on macOS none
// yet, so its letter is read from where the key is. Shift is part of a character typed, so it is said only of a key
// that types none, and with Alt. Ctrl and Meta are always said, so a browser's own shortcut is no key of the table.
export function chordOf({ key, code, altKey, ctrlKey, metaKey, shiftKey }: Pick<Pressed, "key" | "code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): string {
  const base = altKey ? code.replace(/^Key/, "") : (written[key] ?? key);
  // A key that types a character says it as `key`, one character long; one that types none says its name.
  const shift = shiftKey && (altKey || key.length > 1);
  return [ctrlKey && "Ctrl", metaKey && "Meta", altKey && "Alt", shift && "Shift", base].filter((part) => part !== false).join("+");
}

// [LAW:single-enforcer] A press where `keys` are heard: the key of its chord acts, on `acts`, and the press does nothing
// else. Held, the press is the key's still, and the key acts again only if it repeats. A press already handled where it
// was made is left alone, and so is one that is part of an input method's composition: the Enter that commits one is
// typing. Safari ends the composition before that Enter's keydown, which it reports with keyCode 229.
export function press<Acts>(keys: readonly Key<Acts>[], event: Pressed, acts: Acts): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const chord = chordOf(event);
  const key = keys.find((key) => key.chord === chord);
  if (key === undefined) return;
  event.preventDefault();
  if (!event.repeat || key.repeats) key.act(acts);
}

// A press on the page, where `keys` are heard outside a field: nothing, when what it was made in takes keys for its own.
export function pressOutside<Acts>(keys: readonly Key<Acts>[], event: Pressed, acts: Acts): void {
  if (!takesKeys(event.target)) press(keys, event, acts);
}

// Whether what a key was pressed in takes keys for its own: a field typed or chosen in, the terminal's among them.
function takesKeys(target: EventTarget | null): boolean {
  const { isContentEditable, tagName } = (target ?? {}) as Partial<Pick<HTMLElement, "isContentEditable" | "tagName">>;
  return isContentEditable === true || (tagName !== undefined && ["INPUT", "TEXTAREA", "SELECT"].includes(tagName));
}

// The page hears `keys` while what calls this is mounted, each acting on the `acts` of the render last committed.
export function useKeys<Acts>(keys: readonly Key<Acts>[], acts: Acts): void {
  const latest = useRef(acts);
  useLayoutEffect(() => {
    latest.current = acts;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => pressOutside(keys, event, latest.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);
}

// A control's title, `says`, with the keys that do what a click on it does.
export const withKeys = (says: string, ...keys: Pick<Key<never>, "chord">[]): string => `${says} (${keys.map(({ chord }) => chord).join(", ")})`;
