import type { ProxyStatus } from "@cc-dump/proxy/format";
import { useEffect, useState } from "react";
import type { Connection } from "./connection/connection.ts";

// [LAW:types-are-the-program] Where the proxy's status stands: not yet sent, the latest sent, or failed.
export type StatusReading = { state: "connecting" } | { state: "status"; status: ProxyStatus } | { state: "failed"; error: Error };

// The proxy's status, for as long as the component using it is mounted. It follows the proxy across its restarts.
export function useProxyStatus(connection: Connection): StatusReading {
  const [reading, setReading] = useState<StatusReading>({ state: "connecting" });
  useEffect(() => {
    const abort = new AbortController();
    connection.status({ status: (status) => setReading({ state: "status", status }), failed: (error) => setReading({ state: "failed", error }) }, abort.signal);
    return () => abort.abort();
  }, [connection]);
  return reading;
}
