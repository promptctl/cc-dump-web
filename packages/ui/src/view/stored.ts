import { Malformed } from "@cc-dump/log/failure";
import { fields, jsonObject, nullable } from "@cc-dump/log/json";
import { tmuxWindow } from "@cc-dump/server/format";
import { boolean, keep, text, type Field, type Fields, type Item } from "../stored.ts";
import type { Position } from "./position.ts";
import { rowKeys } from "./rows.ts";
import type { Current } from "./search.ts";
import type { Moment, Terminal, View } from "./state.ts";

// [LAW:one-source-of-truth] The view a tab keeps in sessionStorage (docs/design/01-features.md, F12): the view, beside
// the scheme of the row keys its choices, place and current match are kept by.
export const storedView = (initial: View): Item<View> => ({
  name: "cc-dump.view",
  fallback: initial,
  parse: (json, dropped) => {
    const item = jsonObject(json, "stored view");
    return keep({ fields: viewFields(item.keys === rowKeys) }, initial, item.view, "view", dropped);
  },
  write: (view) => ({ keys: rowKeys, view }),
});

// [LAW:types-are-the-program] Each field of the view, read on its own, so a field of a shape this build does not read
// is dropped and the others kept. A field kept by row key, stored under another scheme of them, names rows this build's
// keys do not, so it is dropped too; the recording, terminal, moment and query are kept.
function viewFields(sameKeys: boolean): Fields<View> {
  const keyed = <T,>(field: Field<T>): Field<T> =>
    sameKeys
      ? field
      : (_value, what) => {
          throw new Malformed(`${what}: is kept by row keys of another scheme than this build's, ${rowKeys}`);
        };
  return {
    open: nullable(text),
    terminal: nullable(terminal),
    opened: keyed({ entries: boolean }),
    position: keyed(position),
    moment,
    search: { fields: { query: text, current: keyed(nullable(current)) } },
  };
}

function terminal(value: unknown, what: string): Terminal {
  const f = fields(value, what);
  return { window: tmuxWindow(fields(f.object("window"), `${what}.window`)), shown: f.boolean("shown") };
}

const positions = { end: true, start: true, row: true } satisfies Record<Position["at"], true>;

// An offset into a row as the view writes one (position.ts): a number of pixels, from the row's top.
const isOffset = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function position(value: unknown, what: string): Position {
  const f = fields(value, what);
  const at = f.oneOf("at", positions);
  return at === "row" ? { at, key: f.string("key"), offset: f.read("offset", isOffset, "a number of pixels") } : { at };
}

const moments = { now: true, left: true, chosen: true } satisfies Record<Moment["at"], true>;

function moment(value: unknown, what: string): Moment {
  const f = fields(value, what);
  const at = f.oneOf("at", moments);
  return at === "now" ? { at } : { at, trace: f.string("trace") };
}

function current(value: unknown, what: string): Current {
  const f = fields(value, what);
  return { key: f.string("key"), at: f.string("at"), nth: f.count("nth"), pattern: f.string("pattern") };
}
