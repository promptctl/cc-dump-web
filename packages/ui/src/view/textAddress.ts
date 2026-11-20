import { fieldLines, type Field } from "../format/parts.ts";
import { regionKey } from "./regions.ts";

// [LAW:types-are-the-program] The address of a text a block shows, its slot in the block: its name, a part's text, JSON
// or diff, or the name or value of a line of a part's fields. The search and the view both name a text by it.
export type Address = { kind: "name" } | PartAddress | { kind: "field"; part: number; field: number; side: "name" | "value" };

// The address of a part's own text: a text, its JSON or its diff, the texts that have regions and contents.
export type PartAddress = { kind: "part"; part: number };

export const address = {
  name: { kind: "name" } satisfies Address,
  part: (part: number): PartAddress => ({ kind: "part", part }),
  field: (part: number, field: number, side: "name" | "value"): Address => ({ kind: "field", part, field, side }),
};

// An address's slot as its part, its field line and its side, compared in that order: the name before the parts, the
// parts in order, a part's own text before its field lines, the lines in order, a line's name before its value.
function slot(at: Address): [part: number, field: number, side: number] {
  switch (at.kind) {
    case "name":
      return [-1, -1, 0];
    case "part":
      return [at.part, -1, 0];
    case "field":
      return [at.part, at.field, at.side === "name" ? 0 : 1];
  }
}

// [LAW:one-source-of-truth] The order of a block's slots, the order the view shows a block's texts in. It is stated by
// the addresses, not by a list of the texts, so that an address the block no longer shows, its text taken away by a
// later step, still has a place among those it shows.
export function compareAddresses(a: Address, b: Address): number {
  const [left, right] = [slot(a), slot(b)];
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

// The key of a block's part, under which its regions and contents are kept: the block's row key and the part's number.
export const partKey = (key: string, at: PartAddress): string => `${key}/${at.part}`;

// [LAW:one-source-of-truth] The key of what opens on `line` of the text at `at` in the block's row `blockKey`, a long
// region or a heading's section: the choices keep it by this key, a step opens it by it, and a heading on that line is
// drawn with it as its id, so one name keeps a section and finds its heading.
export const keyAt = ({ blockKey, at }: { blockKey: string; at: PartAddress }, line: number): string => regionKey(partKey(blockKey, at), line);

// A text of a fields part's line: its address and its characters.
type Addressed = { at: Address; text: string };

// [LAW:one-source-of-truth] The lines of the fields of the part at `index`, addressed: each line's depth among the
// fields holding it, its name, and its value, none for a field that holds fields. The view renders them and the search
// reads them, so the address a step goes to is the one the view paints at.
export function fieldTexts(fields: Field[], index: number): { depth: number; name: Addressed; value: Addressed | undefined }[] {
  return fieldLines(fields).map(({ name, value, depth }, field) => ({
    depth,
    name: { at: address.field(index, field, "name"), text: name },
    value: value === undefined ? undefined : { at: address.field(index, field, "value"), text: value },
  }));
}
