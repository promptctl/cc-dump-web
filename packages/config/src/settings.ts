import { Malformed } from "@cc-dump/log/failure";

// One setting: its default, written as a settings file would hold it, and its parse.
export type Setting<T> = { default: unknown; parse: (value: unknown) => T };
export type Table = Record<string, Setting<unknown>>;
export type SettingsOf<T extends Table> = { [K in keyof T]: ReturnType<T[K]["parse"]> };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] The settings of `table` in `object`, `what` in what it says,
// every one of them: a message carrying them, or a settings file with its defaults beside what it sets
// (`withDefaults`). Imports nothing that needs node, so the UI parses settings with it too. A setting added to its table
// is read and refused by everything here.
// [LAW:no-silent-failure] A value the part cannot take is refused, naming it, never read as its default: the part would
// act on a setting the user did not set. So is a key it does not know, which is most often a setting misspelled.
export function parseSettings<T extends Table>(what: string, table: T, object: Record<string, unknown>): SettingsOf<T> {
  const unknown = Object.keys(object).filter((key) => !Object.hasOwn(table, key));
  if (unknown.length > 0)
    throw new Malformed(`${what}: no setting is named ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the settings are ${Object.keys(table).join(", ")}`);
  const missing = Object.keys(table).filter((key) => !Object.hasOwn(object, key));
  if (missing.length > 0) throw new Malformed(`${what}: ${missing.join(", ")} missing`);
  return Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, parsed(what, setting, object[key])])) as SettingsOf<T>;
}

// A setting's value as its parse takes it, or its parse's refusal (`Malformed`), saying where the value was. Any other error
// of the parse is its own bug, and passes as it is.
function parsed(what: string, setting: Setting<unknown>, value: unknown): unknown {
  try {
    return setting.parse(value);
  } catch (error) {
    throw error instanceof Malformed ? new Malformed(what, { cause: error }) : error;
  }
}

// `object`, with each setting of `table` it leaves out at its default.
export function withDefaults(table: Table, object: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, setting.default])), ...object };
}
