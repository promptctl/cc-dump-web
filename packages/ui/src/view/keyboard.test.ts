import { describe, expect, it } from "vitest";
import { categories } from "../format/blocks.ts";
import { chordOf, heard, press, pressOutside, withKeys, type AppActs, type ConversationActs, type FieldActs, type Key, type Pressed } from "./keyboard.ts";

// What a keydown holds beside its key.
type Held = Partial<Omit<Pressed, "key" | "target" | "preventDefault">>;

// A keydown as a press reads it: of `key`, with what else it holds, made in `target`. Preventing its default is read
// back from it, as from the browser's.
function keydown(key: string, held: Held = {}, target: object | null = { tagName: "BODY" }): Pressed {
  const event = {
    key,
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    ...held,
    target: target as EventTarget | null,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
  };
  return event;
}
const shift = { shiftKey: true };
// Alt with a letter as macOS reports it: a dead key, or another character, at the letter's place on the keyboard.
const alt = (letter: string): [string, Held] => ["Dead", { altKey: true, code: `Key${letter}` }];

// The acts of each place, each recording what was asked of it.
function recorded() {
  const calls: unknown[][] = [];
  const say =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args]);
  const conversation: ConversationActs = { search: say("search"), match: say("match"), edge: say("edge"), lines: say("lines"), inTime: say("inTime"), sibling: say("sibling"), injected: say("injected"), follow: say("follow"), level: say("level") };
  const field: FieldActs = { match: say("match"), leave: say("leave") };
  const app: AppActs = { help: say("help") };
  return { calls, conversation, field, app };
}

// What each key of a place does, by a press of it: the key pressed, what is held with it, and the act it asks for.
type Press = [key: string, held: Held, call: unknown[]];
const conversationPresses: Press[] = [
  ["/", {}, ["search"]],
  ["n", {}, ["match", "next"]],
  ["N", shift, ["match", "previous"]],
  ["g", {}, ["edge", "top"]],
  ["G", shift, ["edge", "bottom"]],
  ["j", {}, ["lines", 1]],
  ["k", {}, ["lines", -1]],
  ["ArrowLeft", {}, ["inTime", -1]],
  ["ArrowRight", {}, ["inTime", 1]],
  ["[", {}, ["sibling", "previous"]],
  ["]", {}, ["sibling", "next"]],
  [...alt("N"), ["injected", "next"]],
  [...alt("P"), ["injected", "previous"]],
  ["f", {}, ["follow"]],
  ...categories.map((category, index): Press => [`${index + 1}`, {}, ["level", category]]),
];
const fieldPresses: Press[] = [
  ["Enter", {}, ["match", "next"]],
  ["Enter", shift, ["match", "previous"]],
  ["Escape", {}, ["leave"]],
];
const appPresses: Press[] = [["?", shift, ["help"]]];

// The presses of a place say every key the place hears, so a key added to the table is pressed here.
const chords = (keys: readonly Key<never>[]) => keys.map(({ chord }) => chord).sort();
const said = (presses: Press[]) => presses.map(([key, held]) => chordOf(keydown(key, held))).sort();

// Each press made where `keys` are heard, on acts that record: every one does its own act, and no other.
function pressEach<Acts>(keys: readonly Key<Acts>[], presses: Press[], acts: (all: ReturnType<typeof recorded>) => Acts) {
  expect(said(presses)).toEqual(chords(keys));
  for (const [key, held, call] of presses) {
    const all = recorded();
    const event = keydown(key, held);
    press(keys, event, acts(all));
    expect(all.calls).toEqual([call]);
    expect(event.defaultPrevented).toBe(true);
  }
}

describe("the keys", () => {
  it("does what each key says where it is heard, and takes the press for its own", () => {
    pressEach(heard.conversation.keys, conversationPresses, ({ conversation }) => conversation);
    pressEach(heard.field.keys, fieldPresses, ({ field }) => field);
    pressEach(heard.app.keys, appPresses, ({ app }) => app);
  });

  it("acts again while a move is held, and once for any other key, whose held press it takes all the same", () => {
    const moves = ["n", "N", "j", "k", "←", "→", "[", "]", "Alt+N", "Alt+P", "Enter", "Shift+Enter"];
    function holdEach<Acts>(keys: readonly Key<Acts>[], presses: Press[], acts: (all: ReturnType<typeof recorded>) => Acts) {
      for (const [key, held, call] of presses) {
        const all = recorded();
        const event = keydown(key, { ...held, repeat: true });
        press(keys, event, acts(all));
        expect(all.calls).toEqual(moves.includes(chordOf(event)) ? [call] : []);
        expect(event.defaultPrevented).toBe(true);
      }
    }
    holdEach(heard.conversation.keys, conversationPresses, ({ conversation }) => conversation);
    holdEach(heard.field.keys, fieldPresses, ({ field }) => field);
    holdEach(heard.app.keys, appPresses, ({ app }) => app);
  });

  it("leaves a press that is no key to the browser", () => {
    const { calls, conversation } = recorded();
    const other = keydown("x");
    press(heard.conversation.keys, other, conversation);
    expect(other.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  it("hears no key of the conversation or the app in a field, the terminal's among them", () => {
    const fields = [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }];
    for (const target of fields) {
      const { calls, conversation, app } = recorded();
      for (const [key, held] of conversationPresses) {
        const typed = keydown(key, held, target);
        pressOutside(heard.conversation.keys, typed, conversation);
        expect(typed.defaultPrevented).toBe(false);
      }
      pressOutside(heard.app.keys, keydown("?", shift, target), app);
      expect(calls).toEqual([]);
    }
  });

  it("hears them anywhere else on the page", () => {
    for (const target of [{ tagName: "BODY" }, { tagName: "BUTTON", isContentEditable: false }, null]) {
      const { calls, conversation } = recorded();
      pressOutside(heard.conversation.keys, keydown("f", {}, target), conversation);
      expect(calls).toEqual([["follow"]]);
    }
  });

  it("leaves alone a press already handled where it was made, and one that is an input method composing", () => {
    const { calls, field } = recorded();
    press(heard.field.keys, keydown("Enter", { defaultPrevented: true }), field);
    const composing = keydown("Enter", { isComposing: true });
    press(heard.field.keys, composing, field);
    // Safari's Enter that commits a composition.
    const committing = keydown("Enter", { keyCode: 229 });
    press(heard.field.keys, committing, field);
    expect(calls).toEqual([]);
    expect([composing.defaultPrevented, committing.defaultPrevented]).toEqual([false, false]);
  });

  it("leaves the browser's own shortcuts alone: a key held with Ctrl or Meta, or with a Shift or an Alt the table does not say, is no key", () => {
    const { calls, conversation } = recorded();
    const presses = [
      keydown("f", { ctrlKey: true }),
      keydown("g", { metaKey: true }),
      keydown("1", { ctrlKey: true }),
      keydown("ArrowLeft", { metaKey: true }),
      keydown("ArrowLeft", shift),
      keydown("ArrowLeft", { altKey: true, code: "ArrowLeft" }),
      keydown("Dead", { altKey: true, shiftKey: true, code: "KeyN" }),
      keydown("¡", { altKey: true, code: "Digit1" }),
    ];
    for (const event of presses) {
      press(heard.conversation.keys, event, conversation);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("says a press as the table writes a chord", () => {
    expect(chordOf(keydown("n"))).toBe("n");
    // Shift is part of the character typed.
    expect(chordOf(keydown("N", shift))).toBe("N");
    expect(chordOf(keydown("?", shift))).toBe("?");
    expect(chordOf(keydown("Enter", shift))).toBe("Shift+Enter");
    expect(chordOf(keydown("Escape"))).toBe("Esc");
    expect(chordOf(keydown("ArrowRight"))).toBe("→");
    // With Alt the letter is read from the key's place: Windows types the letter, macOS another character or none yet.
    expect(chordOf(keydown("n", { altKey: true, code: "KeyN" }))).toBe("Alt+N");
    expect(chordOf(keydown(...alt("N")))).toBe("Alt+N");
    expect(chordOf(keydown("s", { ctrlKey: true, metaKey: true }))).toBe("Ctrl+Meta+s");
  });

  it("hears each chord once in a place, and once across the app and the conversation, which the page hears together", () => {
    const once = (keys: readonly Key<never>[]) => expect(new Set(chords(keys)).size).toBe(keys.length);
    once(heard.conversation.keys);
    once(heard.field.keys);
    once(heard.app.keys);
    once([...heard.app.keys, ...heard.conversation.keys]);
  });

  it("gives each category the digit of its place in the filter bar", () => {
    expect(heard.conversation.keys.filter(({ chord }) => /^\d$/.test(chord)).map(({ chord }) => chord)).toEqual(categories.map((_, index) => `${index + 1}`));
  });

  it("names a control's keys in its title", () => {
    expect(withKeys("Next match", { chord: "Enter" }, { chord: "n" })).toBe("Next match (Enter, n)");
  });
});
