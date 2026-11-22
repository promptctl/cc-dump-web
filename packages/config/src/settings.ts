import { object, type Reader, type Readers } from "@cc-dump/log/json";

// One setting: its default, written as a settings file would hold it, and its reader.
export type Setting<T> = { default: unknown; read: Reader<T> };
export type Table = Record<string, Setting<unknown>>;
export type SettingsOf<T extends Table> = { [K in keyof T]: T[K] extends Setting<infer S> ? S : never };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] The settings of `table`, every one of them: a message carrying
// them, or a settings file with its defaults beside what it sets (`withDefaults`). Imports nothing that needs node, so
// the UI reads settings with it too. A setting added to its table is read and refused by everything here.
// [LAW:no-silent-failure] A value the part cannot take is refused, never read as its default: the part would act on a
// setting the user did not set. So is a key it does not know, which is most often a setting misspelled.
export const settings = <T extends Table>(table: T): Reader<SettingsOf<T>> =>
  object(Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, setting.read])) as Readers<SettingsOf<T>>, "refuse");

// `object`, with each setting of `table` it leaves out at its default.
export function withDefaults(table: Table, object: Record<string, unknown>): Record<string, unknown> {
  return { ...Object.fromEntries(Object.entries(table).map(([key, setting]) => [key, setting.default])), ...object };
}
