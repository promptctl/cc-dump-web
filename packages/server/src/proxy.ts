import { LOOPBACK } from "@cc-dump/log/address";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseProxyInfo, type ProxyInfo } from "@cc-dump/proxy/format";

// [LAW:one-source-of-truth] What the running proxy says it is, asked of it each time: it may have restarted, on
// another port, since the app server last asked. A proxy on this machine answers at once; one that has not answered
// within `timeoutMs` (something else holding its port, a proxy wedged) fails the ask, so a launch waiting on it ends.
export async function fetchProxyInfo(readerPort = READER_PORT, timeoutMs = 2000): Promise<ProxyInfo> {
  const url = `http://${LOOPBACK}:${readerPort}/info`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return parseProxyInfo(await res.text());
  } catch (error) {
    throw new Error(`GET ${url}`, { cause: error });
  }
}
