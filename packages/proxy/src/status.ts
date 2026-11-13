import { readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { describeError, startSpan, type Handler, type Log } from "@cc-dump/log";
import type { ProxyStatus, ReadFailure } from "./format.ts";
import { sha256, type Source } from "./source.ts";

// [LAW:types-are-the-program] Whether the proxy runs the source on disk. `changed`: the files whose text on disk
// differs from the text the proxy runs, or that are gone; a restart is pending while there is one. A watch that
// failed says so, and is never an empty `changed`: a dead watch must not read as nothing pending.
export type SourceState = { state: "watching"; changed: string[] } | { state: "failed"; error: Error };

// The watch's state now, and a listener called after each change of it, until the function it returned is called.
export type SourceWatch = { state: () => SourceState; onChanged: (listener: () => void) => () => void };

// Watches the directory of each file of `source`. Every event in one checks every file against the text the proxy
// runs (fs.watch does not always name the file), synchronously, so no two checks interleave. The watchers are not
// persistent: they never hold the process open past its shutdown. A watch fails once and stays failed, its
// watchers closed: watching again takes the restart that is then pending anyway.
// [LAW:nothing-unseen] Starting the watch is a `watch_source` event, each check a `source_check` event, and a
// watcher's error a `source_watch` event.
export function watchSource(log: Log, source: Source): SourceWatch {
  let state: SourceState = { state: "watching", changed: [] };
  const listeners = new Set<() => void>();
  const watchers: FSWatcher[] = [];
  const become = (next: SourceState) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const failWith = (error: unknown) => {
    for (const watcher of watchers) watcher.close();
    become({ state: "failed", error: error instanceof Error ? error : new Error(String(error)) });
  };
  const check = () => {
    const span = startSpan();
    try {
      const changed = [...source].filter(([path, hash]) => onDisk(path) !== hash).map(([path]) => path);
      log({ event: "source_check", ...span.end(), outcome: "ok", files_checked: source.size, changed_source: changed });
      become({ state: "watching", changed });
    } catch (error) {
      log({ event: "source_check", ...span.end(), outcome: "error", error: describeError(error), files_checked: source.size });
      failWith(error);
    }
  };

  const directories = new Set([...source.keys()].map(dirname));
  const span = startSpan();
  try {
    for (const directory of directories) {
      const watcher = watch(directory, { persistent: false }, check);
      watcher.on("error", (error) => {
        log({ event: "source_watch", ...startSpan().end(), outcome: "error", error: describeError(error), directory });
        failWith(error);
      });
      watchers.push(watcher);
    }
    log({ event: "watch_source", ...span.end(), outcome: "ok", files: source.size, directories: directories.size });
    // The text on disk may have changed between its load and the watch.
    check();
  } catch (error) {
    log({ event: "watch_source", ...span.end(), outcome: "error", error: describeError(error), files: source.size, directories: directories.size });
    failWith(error);
  }

  return {
    state: () => state,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// The SHA-256 of the file's text, or undefined when it is gone.
function onDisk(path: string) {
  try {
    return sha256(readFileSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// `GET /status` on the reader port: Server-Sent Events, one per state of the watch, the state now first, until the
// reader leaves or the server closes. A failed watch ends the stream with a `failed` event, the one way a failure
// after the headers reaches an EventSource (it takes a cut stream for a dropped connection, and reconnects).
export function createStatus(watch: SourceWatch): Handler {
  return (req, res, { fail }) => {
    if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = () => {
      const now = watch.state();
      if (now.state === "watching") {
        const status: ProxyStatus = { changed_source: now.changed };
        return void res.write(`data: ${JSON.stringify(status)}\n\n`);
      }
      stop();
      fail(now.error);
      const failure: ReadFailure = { message: now.error.message };
      res.end(`event: failed\ndata: ${JSON.stringify(failure)}\n\n`);
    };
    const stop = watch.onChanged(send);
    res.on("close", stop);
    send();
  };
}
