import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { jsonObject, object, parse, parseJson, pathText, readDocument, Refused, type Reader, type Readers } from "@cc-dump/log/json";

// The settings read, and where they came from: `file_keys` is null when there is no file, else the keys the file set;
// every other setting is its default. `unknown_keys`: the keys of the file no setting is named, another build's or a
// setting misspelled, read past and named, since every worktree's build shares the file.
export type ReadSettings<S> = { settings: S; file_keys: string[] | null; unknown_keys: string[] };

// [LAW:one-type-per-behavior] [LAW:parse-dont-validate] A JSON settings file (docs/design/01-features.md, F11), `what`
// in what it says, holding the settings `readers` read, each at its default when the file leaves it out. Each part's
// file is an instance.
// [LAW:no-silent-failure] A value the part cannot take is refused, naming its key, never read as its default: the part
// would act on a setting the user did not set. A default its reader refuses is this build's bug, thrown as the file is
// declared, as the part's module loads.
export function settingsFile<S>(what: string, readers: Readers<S>, defaults: { [K in keyof S]: unknown }) {
  // [LAW:no-silent-failure] A value a setting's reader would replace by a fallback is refused too, as every other
  // value the part cannot take is.
  const settings: Reader<S> = (json, at) => {
    const read = object(readers)(json, at);
    if (read.replaced.length > 0) throw new Refused(read.replaced);
    return read;
  };
  parse(settings, defaults, `${what}'s defaults`);
  // `text` is the file's, or undefined when there is no file; `said`, the file as its failures name it.
  const parseAs =
    (said: string) =>
    (text: string | undefined): ReadSettings<S> => {
      const file = text === undefined ? {} : jsonObject(parseJson(text, said), said);
      const { value, unknown } = readDocument(settings, { ...defaults, ...file }, said);
      return { settings: value, file_keys: text === undefined ? null : Object.keys(file), unknown_keys: unknown.map(({ at }) => pathText(at)) };
    };
  return {
    parse: parseAs(what),
    // A file it cannot take is refused naming it, so the user knows which file to change.
    read: (path: string) => parseAs(`${what} in ${path}`)(fileText(path)),
    // [LAW:one-source-of-truth] The settings `changes` sets, over the file as it is: every other key in it, another
    // build's included, is kept as it was. A file that is no JSON object is refused, naming it, not written over. The
    // file is replaced at once: written beside it, then renamed over it, so a reader never sees half of it.
    write: (path: string, changes: Partial<S>) => {
      const said = `${what} in ${path}`;
      const text = fileText(path);
      const file = text === undefined ? {} : jsonObject(parseJson(text, said), said);
      mkdirSync(dirname(path), { recursive: true });
      const written = `${path}.${process.pid}.tmp`;
      writeFileSync(written, `${JSON.stringify({ ...file, ...changes }, null, 2)}\n`);
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
