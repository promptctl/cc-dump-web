import { object, type Reader, type Readers } from "@cc-dump/log/json";

// One setting: its default, written as a settings file would hold it, and its read.
export type Setting<T> = { default: unknown; read: Reader<T> };
export type Table = Record<string, Setting<unknown>>;
export type SettingsOf<T extends Table> = { [K in keyof T]: T[K] extends Setting<infer V> ? V : never };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] The settings of `table`, every one of them, read by the json
// family, as a field of a message carrying them or as a settings file (`withDefaults`, read by `parseExact`). Imports
// nothing that needs node, so the UI reads settings with it too. A setting added to its table is read by everything here.
// [LAW:no-silent-failure] A value the part cannot take is refused, naming it, never read as its default: the part would
// act on a setting the user did not set.
export function settings<T extends Table>(table: T): Reader<SettingsOf<T>> {
  // [LAW:types-are-the-program] exception: `Object.fromEntries` cannot carry a mapped type over a generic table's keys.
  return object(Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, setting.read])) as Readers<SettingsOf<T>>);
}

// `object`, with each setting of `table` it leaves out at its default.
export function withDefaults(table: Table, object: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, setting.default])), ...object };
}
