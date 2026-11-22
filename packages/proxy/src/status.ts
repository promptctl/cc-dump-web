import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import { eventOwner, logged, startTrace, type Handler, type Log } from "@cc-dump/log";
import { stream, type Route } from "@cc-dump/log/answer";
import { frame } from "@cc-dump/log/wire";
import type { ProxyInfo, ProxyStatus, SourceStatus, Traffic } from "./format.ts";
import { fileHash, type Source } from "./source.ts";

// [LAW:one-source-of-truth] A part of the proxy's state, held by one owner: the state now, and a listener called after
// each change of it, until the function it returned is called. Each is a part of what `GET /status` sends (format.ts).
export type Watched<T> = { state: () => T; onChanged: (listener: () => void) => () => void };

// A state its owner changes by `become`, which tells the listeners; a state equal to the one now is no change.
export function watchable<T>(initial: T): Watched<T> & { become: (next: T) => void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    onChanged: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    become: (next) => {
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

// Watches the directory of each file of `source`. Every event in one checks every file against the text the proxy
// runs (fs.watch does not always name the file), synchronously, so no two checks interleave. The watchers are not
// persistent: they never hold the process open past its shutdown. A watch fails once and stays failed, its
// watchers closed: watching again takes a restart of the proxy.
// [LAW:nothing-unseen] Starting the watch is a `watch_source` event, each check a `source_check` event, and a
// watcher's error a `source_watch` event: the failed state carries the error's message, and its event the whole error.
export function watchSource(log: Log, source: Source): Watched<SourceStatus> {
  const { become, ...watched } = watchable<SourceStatus>({ state: "watching", changed_source: [] });
  const watchers: FSWatcher[] = [];
  const failWith = (error: unknown) => {
    for (const watcher of watchers) watcher.close();
    become({ state: "failed", message: error instanceof Error ? error.message : String(error) });
  };
  // A check's unit of work is the check and the state it makes, which tells the listeners.
  const check = () => {
    try {
      logged(
        log,
        "source_check",
        { files_checked: source.size },
        () => {
          const changed = [...source].filter(([path, hash]) => onDisk(path) !== hash).map(([path]) => path);
          become({ state: "watching", changed_source: changed });
          return changed;
        },
        (changed_source) => ({ changed_source }),
      );
    } catch (error) {
      failWith(error);
    }
  };

  const directories = new Set([...source.keys()].map(dirname));
  try {
    logged(log, "watch_source", { files: source.size, directories: directories.size }, () => {
      for (const directory of directories) {
        const watcher = watch(directory, { persistent: false }, check);
        watcher.on("error", (error) => {
          const watching = eventOwner(log, "source_watch", { directory }, startTrace());
          watching.fail(error);
          watching.end();
          failWith(error);
        });
        watchers.push(watcher);
      }
    });
    // The text on disk may have changed between its load and the watch.
    check();
  } catch (error) {
    failWith(error);
  }

  return watched;
}

// [LAW:single-enforcer] The one count of the proxy's traffic, kept where every request the proxy forwards passes:
// `counted` wraps the forwarding handler, so a request is counted as it arrives, at the time `now` gives, and uncounted as it ends,
// however it ends.
export function countTraffic(now: () => Date = () => new Date()): Watched<Traffic> & { counted: (handler: Handler) => Handler } {
  const { become, ...traffic } = watchable<Traffic>({ in_flight: 0, last_request: null });
  return {
    ...traffic,
    counted: (handler) => (req, res, work) => {
      become({ in_flight: traffic.state().in_flight + 1, last_request: now().toISOString() });
      void work.ended.then(() => become({ ...traffic.state(), in_flight: traffic.state().in_flight - 1 }));
      handler(req, res, work);
    },
  };
}

// The SHA-256 of the file's text, or undefined when it is gone.
function onDisk(path: string) {
  try {
    return fileHash(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// `GET /status` on the reader port: Server-Sent Events, one per state of the proxy, its info, the source watch's state
// and the traffic's together, the state now first and then one at each change of either, until the reader leaves or the server
// closes. A failed watch is one more state, not the stream's end: the stream stays open, so a reader's EventSource sees
// the proxy's restart as a dropped connection and reconnects to the restarted proxy. That open stream is the browser's
// connection to the proxy (F8).
export function createStatus(info: ProxyInfo, source: Watched<SourceStatus>, traffic: Watched<Traffic>): Route {
  return () =>
    stream((res) => {
      const send = () => void res.write(frame({ data: JSON.stringify({ info, source: source.state(), traffic: traffic.state() } satisfies ProxyStatus) }));
      const unwatched = [source.onChanged(send), traffic.onChanged(send)];
      res.on("close", () => unwatched.forEach((unwatch) => unwatch()));
      send();
    });
}
