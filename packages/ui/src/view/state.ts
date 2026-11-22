import { Malformed } from "@cc-dump/log/failure";
import { fieldOf, fields, jsonObject, parseJson } from "@cc-dump/log/json";
import { tmuxWindow, type Launched, type TmuxWindow } from "@cc-dump/server/format";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { OpenRecording } from "../reading.ts";
import { settings, type SearchOptions } from "../settings.ts";
import { recording } from "../store.ts";
import type { Position } from "./position.ts";
import type { By } from "./scroll.ts";
import { isOpen, type Opened } from "./rows.ts";
import type { Current, Step } from "./search.ts";

// [LAW:one-source-of-truth] What the reader has chosen about the view: the recording open, the agent's window their
// launch opened and whether its terminal is shown (F13), each block, set, nest, region or fold they opened or closed
// (rows.ts), where they are, the moment shown, and their search. Everything else on screen is derived from the exchanges
// and the settings. It is kept for the tab in sessionStorage, so after a hot reload or a page reload the view is the
// same (docs/design/01-features.md, F12). A tab opens at the end, now, which follows the conversation while follow is on.
// While it is off, the end becomes the place under the view at the first step.
export type View = { open: OpenRecording; terminal: Terminal | null; opened: Opened; position: Position; moment: Moment; search: Search };

// [LAW:types-are-the-program] The agent's window, and whether its terminal is shown beside the conversation: two facts,
// so a terminal put away is still its window's, and is shown again without another launch.
export type Terminal = { window: TmuxWindow; shown: boolean };

// The moment shown (docs/design/02-design.md, "Two axes"), by its step's exchange: `now`, the latest step,
// whichever it is as exchanges arrive; `left`, the step that was now when the reader's own act (a scroll, a click on a
// block or a fold, a step of the search) took them away from it; or `chosen`, a step the reader moved to in time.
// [LAW:types-are-the-program] The last two are told apart because only `left` resumes: scrolling back to the end with
// follow on resumes following from `now` or `left`, while the end of a chosen step is a place like any other, and
// following resumes from it by the control or a move to the latest step. The view's own placing, a clamp or the end
// becoming a place while follow is off, never changes the moment.
export type Moment = { at: "now" } | { at: "left"; trace: string } | { at: "chosen"; trace: string };

// The search: its query, and the match last stepped to, the one holder of which match is current. Each render reads it
// as the column's judge finds it (moves.ts `judge`), which clears it once it is none, as under a new query or a new
// way of reading it, in every tab.
export type Search = { query: string; current: Current | undefined };

// A tab opens with no recording: the person launches an agent, or opens one.
const initial: View = { open: null, terminal: null, opened: {}, position: { at: "end" }, moment: { at: "now" }, search: { query: "", current: undefined } };

const name = "cc-dump.view";

// [LAW:single-enforcer] persist writes the view; `view.restore` reads it, through the parse, the one gate on what is
// stored, so persist's version is never compared and its own read never runs.
export const useView = create<View>()(persist((): View => initial, { name, storage: createJSONStorage(() => sessionStorage), skipHydration: true }));

// A stored view as read: the view, and each part of it dropped, by name, with why.
export type Restored = { view: View; dropped: Record<string, string> };

// [LAW:parse-dont-validate] The item a tab stored, as persist wrote it (its state beside its version), `null` when it
// stored nothing, read as the View this build has: each part the stored one, or, where what is stored is not a part this build
// reads, the part a new tab opens with, named in `dropped`. So a current match of another shape is dropped and the
// recording, place and choices are kept; text that is not persist's is dropped whole, as the view a new tab opens with.
export function parseView(item: string | null): Restored {
  const dropped: Record<string, string> = {};
  const part = <V, T>(name: string, value: V, read: (value: V, what: string) => T, fallback: T): T => {
    try {
      return read(value, name);
    } catch (error) {
      if (!(error instanceof Malformed)) throw error;
      dropped[name] = error.message;
      return fallback;
    }
  };
  const stored = item === null ? initial : part("view", item, (item, what): unknown => fields(parseJson(item, what), what).object("state"), initial);
  const search = fieldOf(stored, "search");
  const view: View = {
    open: part("open", fieldOf(stored, "open"), (value, what) => (value === null ? null : text(value, what)), initial.open),
    terminal: part("terminal", fieldOf(stored, "terminal"), terminal, initial.terminal),
    opened: part("opened", fieldOf(stored, "opened"), opened, initial.opened),
    position: part("position", fieldOf(stored, "position"), position, initial.position),
    moment: part("moment", fieldOf(stored, "moment"), moment, initial.moment),
    search: {
      query: part("search.query", fieldOf(search, "query"), text, initial.search.query),
      current: part("search.current", fieldOf(search, "current"), current, initial.search.current),
    },
  };
  return { view, dropped };
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Malformed(`${what}: is not a string`);
  return value;
}

function terminal(value: unknown, what: string): Terminal | null {
  if (value === null) return null;
  const f = fields(value, what);
  return { window: tmuxWindow(f.object("window"), `${what}: window`), shown: f.boolean("shown") };
}

function opened(value: unknown, what: string): Opened {
  const entries = Object.values(jsonObject(value, what));
  if (!entries.every((open) => typeof open === "boolean")) throw new Malformed(`${what}: holds a choice that is not a boolean`);
  return value as Opened;
}

function position(value: unknown, what: string): Position {
  const f = fields(value, what);
  const at = f.oneOf("at", { end: true, start: true, row: true });
  return at === "row" ? { at, key: f.string("key"), offset: f.read("offset", Number.isFinite as (value: unknown) => value is number, "a number") } : { at };
}

function moment(value: unknown, what: string): Moment {
  const f = fields(value, what);
  const at = f.oneOf("at", { now: true, left: true, chosen: true });
  return at === "now" ? { at } : { at, trace: f.string("trace") };
}

// A search with no current match stores none: JSON keeps no undefined.
function current(value: unknown, what: string): Current | undefined {
  if (value === undefined) return undefined;
  const f = fields(value, what);
  const nth = f.read("nth", (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0, "a count");
  return { key: f.string("key"), at: f.string("at"), nth, pattern: f.string("pattern") };
}

export const view = {
  // [LAW:no-ambient-temporal-coupling] The tab's stored view read, by the composition root as the page starts and before
  // its first render, with `dropped` told each part of it this build could not read.
  restore: (dropped: (parts: Restored["dropped"]) => void) => {
    const restored = parseView(sessionStorage.getItem(name));
    useView.setState(restored.view, true);
    dropped(restored.dropped);
  },
  // A recording opened is shown as a tab opens, from the end, with no current match: the one there was is the last
  // recording's. Choices are kept: a row's key begins with its exchange's trace_id, so none is another recording's.
  // [LAW:no-ambient-temporal-coupling] The exchanges shown are emptied as it opens, so the view of the last recording's
  // exchanges unmounts in the commit that opens it and never steps on the position the new one opens at. Its read begins
  // as that commit's effects run (useRecording), and reads it from its start, the one already open again as well: a read
  // that failed is opened to try again.
  open: (open: string) => {
    recording.open();
    useView.setState(({ search }) => ({ open, position: { at: "end" }, moment: { at: "now" }, search: { ...search, current: undefined } }));
  },
  // A launch shows its agent: the recording its process makes, opened, and its window, beside it, which stays shown when
  // another recording is opened, since the agent goes on running there.
  launched: ({ recording, start_time, session_id, window_id }: Launched) => {
    view.open(recording);
    useView.setState({ terminal: { window: { start_time, session_id, window_id }, shown: true } });
  },
  // The terminal shown, or put away: the agent runs on in its window either way, and the next launch shows its own.
  showTerminal: (shown: boolean) => useView.setState(({ terminal }) => ({ terminal: terminal && { ...terminal, shown } })),
  // What is kept at `key`, which starts open or not as `starts` says, chosen to show the other way from how it shows.
  toggle: (key: string, starts: boolean) => useView.setState(({ opened }) => ({ opened: { ...opened, [key]: !isOpen(opened, key, starts) } })),
  // The position moved, by `by`. At the end it is following, so the moment is now; a reader's move anywhere else, while
  // the moment is now, leaves it at now's step, `now`, the latest step's exchange.
  place: (position: Position, by: By, now: string | undefined) =>
    useView.setState(({ moment }) => ({ position, moment: position.at === "end" ? { at: "now" } : by === "reader" ? leave(moment, now) : moment })),
  // A move in time, to `moment`, with the view put at `position`, and no current match: the one there was is in another
  // moment's text, where the search, which walks the moment shown, no longer counts it.
  moveInTime: (moment: Exclude<Moment, { at: "left" }>, position: Position) =>
    useView.setState(({ search }) => ({ moment, position, search: { ...search, current: undefined } })),
  search: (query: string) => useView.setState(({ search }) => ({ search: { ...search, query } })),
  // [LAW:one-source-of-truth] The option is the settings', which every tab shares.
  searchOption: (option: keyof SearchOptions, on: boolean) => settings.setSearchOption(option, on),
  // The current match is none (moves.ts `judge`).
  clearMatch: () => useView.setState(({ search }) => ({ search: { ...search, current: undefined } })),
  // A step to a match, the reader's act, with now's step `now`: it becomes current, the folds holding it show open, and
  // the view moves to its row, which the step then refines to the match's line. The folds are chosen open, however they
  // start, as the reader's choice (docs/design/01-features.md, F4), so a later change of level, which moves how a set or
  // a block starts, never hides the current match: what the search stepped into stays open at a level that starts it
  // closed, until the reader closes it.
  goTo: ({ match, folds }: Step, now: string | undefined) => useView.setState((state) => ({ ...movedTo(state, match.key, folds, now), search: { ...state.search, current: match } })),
  // A click on an entry of a text's contents (contents.ts), the reader's act, with now's step `now`: the folds that show
  // the entry's heading and what stands under it, `folds`, show open, and the view moves to the row of its block,
  // `key`, which the click then refines to the heading's line.
  toHeading: (key: string, folds: string[], now: string | undefined) => useView.setState((state) => movedTo(state, key, folds, now)),
};

// [LAW:single-enforcer] The reader's move to something in the row `key`, with now's step `now`: each of `opens` the
// choices do not hold open is chosen open, the choices the record they were if they hold all of them open, the view is
// at the row's top, and now is left.
function movedTo({ opened, moment }: View, key: string, opens: string[], now: string | undefined): Pick<View, "opened" | "position" | "moment"> {
  const closed = opens.filter((open) => opened[open] !== true);
  return {
    opened: closed.length === 0 ? opened : { ...opened, ...Object.fromEntries(closed.map((open) => [open, true] as const)) },
    position: { at: "row", key, offset: 0 },
    moment: leave(moment, now),
  };
}

// The moment once the reader's own act takes them away from now's step, `now`: left there, or, if it is not now, as it
// was. Before any exchange there is no step to leave.
function leave(moment: Moment, now: string | undefined): Moment {
  return moment.at === "now" && now !== undefined ? { at: "left", trace: now } : moment;
}
