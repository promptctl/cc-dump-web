import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { jsonObject, object, parseExact, parseJson } from "@cc-dump/log/json";
import type { Settings } from "./settings.ts";

// The settings read, and where they came from: `file_keys` is null when there is no file, else the settings the file
// set; every other setting is its default.
export type ReadSettings<S> = { settings: S; file_keys: string[] | null };

// A JSON settings file (docs/design/01-features.md, F11), `what` in what it says, holding `settings`. Each part's file is
// an instance. [LAW:no-silent-failure] A value the part cannot take is refused, naming it, never read as its default:
// the part would act on a setting the user did not set. So is a key it does not read, which is most often a setting
// misspelled (`parseExact`).
export function settingsFile<S>(what: string, { readers, defaults }: Settings<S>) {
  const reader = object(readers);
  // `text` is the file's, or undefined when there is no file; `said`, the file as its failures name it.
  const parseAs =
    (said: string) =>
    (text: string | undefined): ReadSettings<S> => {
      const file = text === undefined ? {} : jsonObject(parseJson(text, said), said);
      return { settings: parseExact(reader, { ...defaults, ...file }, said), file_keys: text === undefined ? null : Object.keys(file) };
    };
  return {
    parse: parseAs(what),
    // A file it cannot take is refused naming it, so the user knows which file to change.
    read: (path: string) => parseAs(`${what} in ${path}`)(fileText(path)),
    // The whole file, replaced at once: written beside it, then renamed over it, so a reader never sees half of it.
    write: (path: string, settings: S) => {
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
