import type { ProxyStatus } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";

// [LAW:types-are-the-program] Where the UI's connection to the proxy stands (docs/design/01-features.md, F8): being made,
// made and holding the proxy's latest status, made but its latest status unreadable (the next may be), lost or not made
// and being tried again, or failed: not served, and closed.
export type StatusReading =
  | { state: "connecting" }
  | { state: "connected"; status: ProxyStatus }
  | { state: "unreadable"; error: Error }
  | { state: "dropped" }
  | { state: "failed"; error: Error };

// The proxy's status, for as long as the component using it is mounted. It follows the proxy across its restarts.
export function useProxyStatus(connection: Connection): StatusReading {
  const [reading, setReading] = useState<StatusReading>({ state: "connecting" });
  useEffect(() => {
    const abort = new AbortController();
    connection.status(
      {
        status: (status) => setReading({ state: "connected", status }),
        unreadable: (error) => setReading({ state: "unreadable", error }),
        dropped: () => setReading({ state: "dropped" }),
        failed: (error) => setReading({ state: "failed", error }),
      },
      abort.signal,
    );
    return () => abort.abort();
  }, [connection]);
  return reading;
}

// [LAW:no-ambient-temporal-coupling] The time now, as milliseconds since the epoch, read again every `period`
// milliseconds for as long as the component using it is mounted: the one clock a display of elapsed time reads.
export function useNow(period: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const ticking = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(ticking);
  }, [period]);
  return now;
}

// How long before `now` the time `then` was, both in milliseconds since the epoch, as a person reads it at a glance:
// seconds under a minute, minutes under an hour, hours under a day, then days. A time ahead of `now` (the proxy's clock
// a little ahead of the browser's) is "now".
export function ago(then: number, now: number): string {
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
