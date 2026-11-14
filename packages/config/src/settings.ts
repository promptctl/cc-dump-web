// One setting: its default, written as a settings file would hold it, and its parse.
export type Setting<T> = { default: unknown; parse: (value: unknown) => T };
export type Table = Record<string, Setting<unknown>>;
export type SettingsOf<T extends Table> = { [K in keyof T]: ReturnType<T[K]["parse"]> };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] The settings of `table` in `object`, `what` in what it says,
// wherever they were written: a settings file, or a message carrying them. Imports nothing that needs node, so the UI
// parses settings with it too. A setting added to its table is read, defaulted and refused by everything here.
// [LAW:no-silent-failure] A value the part cannot take is refused, naming it, never read as its default: the part would
// act on a setting the user did not set. So is a key it does not know, which is most often a setting misspelled.
export function parseSettings<T extends Table>(what: string, table: T, object: Record<string, unknown>): SettingsOf<T> {
  const unknown = Object.keys(object).filter((key) => !Object.hasOwn(table, key));
  if (unknown.length > 0)
    throw new Error(`${what}: no setting is named ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the settings are ${Object.keys(table).join(", ")}`);
  const taken = Object.entries(table).map(([key, setting]) => [key, setting.parse(Object.hasOwn(object, key) ? object[key] : setting.default)]);
  return Object.fromEntries(taken) as SettingsOf<T>;
}
