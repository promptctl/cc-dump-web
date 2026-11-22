// Whether two JSON values are the same value: an object's fields in any order, an undefined field as none. A block is
// such a value (format/blocks.ts), so this is what two blocks are alike by, for the formatter that keeps one of them
// (format/format.ts) and for the history that compares a resent block with its item (view/history.ts).
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const fields = (value: object) => Object.entries(value).filter(([, field]) => field !== undefined);
  const own = fields(a);
  const other = new Map(fields(b));
  return own.length === other.size && own.every(([name, field]) => other.has(name) && equal(field, other.get(name)));
}
