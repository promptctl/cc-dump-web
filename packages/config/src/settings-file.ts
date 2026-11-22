import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { droppedOf, entries, fromJsonText, object, parse, parseReported, raw, readShown, words, type Dropped, type Json, type Readers } from "@cc-dump/log/json";

// The settings read, and where they came from: `file_keys` is null when there is no file, else the settings the file
// set, every other setting its default; `unread`, each key the file holds that this build does not read.
export type ReadSettings<S> = { settings: S; file_keys: string[] | null; unread: readonly Dropped[] };

// The settings as a file holds them, each at its default.
export type Defaults<S> = { readonly [K in keyof S]: Json };

const fileObject = fromJsonText(entries(raw));

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] A JSON settings file (docs/design/01-features.md, F11), `what`
// in what it says, holding the settings `readers` read, each at its value in `defaults` where the file sets none. Each
// part's file is an instance.
// [LAW:no-silent-failure] A value the part cannot take is refused, naming it, never read as its default: the part would
// act on a setting the user did not set. A key it does not read is read past and named, since every worktree shares the
// file, and a build must still read a file a newer one wrote.
export function settingsFile<S>(what: string, readers: Readers<S>, defaults: Defaults<S>) {
  const settings = object(readers);
  // [LAW:single-enforcer] The defaults are this build's own, so one it cannot read is its bug, found as it is declared.
  const declared = readShown(settings, defaults);
  const wrong = declared.is === "refused" ? [declared.why] : droppedOf(declared.read).map(words);
  if (wrong.length > 0) throw new Error(`${what} defaults: ${wrong.join("; ")}`);

  // `text` is the file's, or undefined when there is no file; `said`, the file as its failures name it.
  const parseAs =
    (said: string) =>
    (text: string | undefined): ReadSettings<S> => {
      const file = text === undefined ? {} : parse(fileObject, text, said);
      const { value, unread } = parseReported(settings, { ...defaults, ...file }, said);
      return { settings: value, file_keys: text === undefined ? null : Object.keys(file), unread };
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
