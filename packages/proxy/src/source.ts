import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The proxy's source: each file node loaded to run it, by path, with the SHA-256 of its text on disk as node loaded it.
export type Source = ReadonlyMap<string, string>;

// [LAW:one-source-of-truth] Records the proxy's source as node loads it, so the files are node's own and not a
// list kept by hand. Imports only node's builtins: a module this one imported would load before the hook exists.
// What did load before it, `loadedBefore` (the entry's URL) and this module, is recorded now. `loaded()` ends the
// record and returns it; the proxy loads every module it runs at start.
// [LAW:single-enforcer] A file is recorded by `fileHash`, the one hash its watch compares too (status.ts): the text a
// load hook further down the chain hands back may be transformed (a coverage loader, tsx), and never matches the file.
export function recordSource(...loadedBefore: string[]) {
  const source = new Map<string, string>();
  const record = (url: string) => source.set(fileURLToPath(url), fileHash(fileURLToPath(url)));
  for (const url of [import.meta.url, ...loadedBefore]) record(url);
  const hooks = registerHooks({
    load: (url, context, nextLoad) => {
      const loaded = nextLoad(url, context);
      if (url.startsWith("file:")) record(url);
      return loaded;
    },
  });
  return {
    loaded: (): Source => {
      hooks.deregister();
      return source;
    },
  };
}

// The SHA-256 of the file's text on disk.
export function fileHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
