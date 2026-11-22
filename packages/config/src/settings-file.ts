import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kinds, parse, parseExact, parseJson, value } from "@cc-dump/log/json";
import { settings, withDefaults, type SettingsOf, type Table } from "./settings.ts";

// The settings read, and where they came from: `file_keys` is null when there is no file, else the settings the file
// set; every other setting is its default.
export type ReadSettings<S> = { settings: S; file_keys: string[] | null };

// A JSON settings file (docs/design/01-features.md, F11), `what` in what it says, holding the settings of `table`. Each
// part's file is an instance.
export function settingsFile<T extends Table>(what: string, table: T) {
  // `text` is the file's, or undefined when there is no file; `said`, the file as its failures name it. A key the file
  // holds that no setting reads is refused, since most often it is a setting misspelled.
  const reader = settings(table);
  const parseAs = (said: string) => (text: string | undefined): ReadSettings<SettingsOf<T>> => {
    const file = text === undefined ? {} : parse(value(kinds.object), parseJson(text, said), said);
    return { settings: parseExact(reader, withDefaults(table, file), said), file_keys: text === undefined ? null : Object.keys(file) };
  };
  // [LAW:no-silent-failure] Each default is what a file would hold, which no type ties to its setting's read, so the
  // defaults are read as no file is, as the table is made: one its read refuses fails the part's start, naming it.
  parseAs(`${what}'s defaults`)(undefined);
  return {
    parse: parseAs(what),
    // A file it cannot take is refused naming it, so the user knows which file to change.
    read: (path: string) => parseAs(`${what} in ${path}`)(fileText(path)),
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
