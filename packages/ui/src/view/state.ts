import { Malformed } from "@cc-dump/log/failure";
import { drop, entries, kinds, nullable, object, tagged, tolerant, value, type Read, type Reader } from "@cc-dump/log/json";
import { windowReaders, type Launched, type TmuxWindow } from "@cc-dump/server/format";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { OpenRecording } from "../reading.ts";
import { settings, type SearchOptions } from "../settings.ts";
import { stored, type Item } from "../stored.ts";
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

// [LAW:one-source-of-truth] The stored view's version: the scheme of the row keys it holds, as rows.ts, history.ts,
// format/format.ts, search.ts, regions.ts and contents.ts make them. rowKeys.test.ts pins a key of each kind beside it,
// so a key made another way fails there, where the version it is stored under is changed with it.
export const viewVersion = 7;

const moment = drop(tagged<"at", Moment>("at", { now: {}, left: { trace: value(kinds.string) }, chosen: { trace: value(kinds.string) } }));
const current = drop(object<Current>({ key: value(kinds.string), at: value(kinds.string), nth: value(kinds.integer), pattern: value(kinds.string) }));

// [LAW:parse-dont-validate] A view as stored under `version`, read as this build reads it: each field it holds kept,
// and one of a shape this build does not read (a current match an older build stored), its first state, named. Each
// field is a choice of its own, so one dropped leaves the rest.
// A row key of another scheme names another row or none, so under another version each value that names a row (each
// fold, a place at a row, the current match) is refused as it is read, and dropped and named alone; a place at the start
// or the end, and all else, is kept.
export function readView(state: unknown, version: number): Read<View> {
  const rows = <T,>(reader: Reader<T>): Reader<T> =>
    version === viewVersion
      ? reader
      : () => {
          throw new Malformed(`names a row as row-key scheme ${version} does; this build's is ${viewVersion}`);
        };
  return tolerant<View>(
    {
      open: nullable(value(kinds.string)),
      terminal: nullable(drop(object<Terminal>({ window: drop(object(windowReaders)), shown: value(kinds.boolean) }))),
      opened: entries(rows(value(kinds.boolean))),
      position: drop(tagged<"at", Position>("at", { end: {}, start: {}, row: { key: rows(value(kinds.string)), offset: value(kinds.number) } })),
      moment,
      search: tolerant<Search>({ query: value(kinds.string), current: rows(current) }, initial.search),
    },
    initial,
  )(state, []);
}

// The view as the tab keeps it, in sessionStorage, in `storage` for a test.
export const viewItem = (storage: () => Storage): Item<View> => ({ name: "cc-dump.view", version: viewVersion, storage, initial, read: readView });

export const useView = create<View>()(persist((): View => initial, stored(viewItem(() => sessionStorage))));

export const view = {
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
