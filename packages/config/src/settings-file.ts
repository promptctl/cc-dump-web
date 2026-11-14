import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { jsonObject, parseJson } from "@cc-dump/log/json";

// One setting of a settings file: its default, written as the file would hold it, and its parse.
export type Setting<T> = { default: unknown; parse: (value: unknown) => T };
type Table = Record<string, Setting<unknown>>;
export type SettingsOf<T extends Table> = { [K in keyof T]: ReturnType<T[K]["parse"]> };

// The settings read, and where they came from: `file_keys` is null when there is no file, else the settings the file
// set; every other setting is its default.
export type ReadSettings<S> = { settings: S; file_keys: string[] | null };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] A JSON settings file (docs/design/01-mvp.md, F11), `what` in
// what it says, holding the settings of `table`. Each part's file is an instance; a setting added to its table is read,
// defaulted and refused by everything here.
export function settingsFile<T extends Table>(what: string, table: T) {
  // [LAW:no-silent-failure] `text` is the file's, or undefined when there is no file. A value the part cannot take is
  // refused, naming it, never read as its default: the part would act on a setting the user did not set. So is a key
  // it does not know, which is most often a setting misspelled.
  const parse = (text: string | undefined): ReadSettings<SettingsOf<T>> => {
    const file = text === undefined ? {} : jsonObject(parseJson(text, what), what);
    const unknown = Object.keys(file).filter((key) => !Object.hasOwn(table, key));
    if (unknown.length > 0)
      throw new Error(`${what}: no setting is named ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the settings are ${Object.keys(table).join(", ")}`);
    const taken = Object.entries(table).map(([key, setting]) => [key, setting.parse(Object.hasOwn(file, key) ? file[key] : setting.default)]);
    return { settings: Object.fromEntries(taken) as SettingsOf<T>, file_keys: text === undefined ? null : Object.keys(file) };
  };
  return {
    parse,
    read: (path: string) => parse(fileText(path)),
    // The whole file, replaced at once: written beside it, then renamed over it, so a reader never sees half of it.
    write: (path: string, settings: SettingsOf<T>) => {
      mkdirSync(dirname(path), { recursive: true });
      const written = `${path}.${process.pid}.tmp`;
      writeFileSync(written, `${JSON.stringify(settings, null, 2)}\n`);
      renameSync(written, path);
    },
  };
}

function fileText(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
