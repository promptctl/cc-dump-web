import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The proxy's source: each file node loaded to run it, by path, with the SHA-256 of the text node ran.
export type Source = ReadonlyMap<string, string>;

// [LAW:one-source-of-truth] Records the proxy's source as node loads it, so the files are node's own and not a
// list kept by hand. Imports only node's builtins: a module this one imported would load before the hook exists.
// What did load before it, `loadedBefore` (the entry's URL) and this module, is hashed from disk now. `loaded()`
// ends the record and returns it; the proxy loads every module it runs at start.
export function recordSource(...loadedBefore: string[]) {
  const source = new Map<string, string>();
  for (const url of [import.meta.url, ...loadedBefore]) source.set(fileURLToPath(url), sha256(readFileSync(fileURLToPath(url))));
  const hooks = registerHooks({
    load: (url, context, nextLoad) => {
      const loaded = nextLoad(url, context);
      if (url.startsWith("file:")) {
        if (loaded.source == null) throw new Error(`${url} loaded with no text to record`);
        source.set(fileURLToPath(url), sha256(loaded.source));
      }
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

export function sha256(text: string | ArrayBuffer | NodeJS.ArrayBufferView) {
  return createHash("sha256")
    .update(text instanceof ArrayBuffer ? new Uint8Array(text) : text)
    .digest("hex");
}
