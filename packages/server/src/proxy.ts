import { LOOPBACK } from "@cc-dump/log/address";
import { ask } from "@cc-dump/log/wire";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListing, parseProxyInfo, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";

// [LAW:one-source-of-truth] What the running proxy says it is, asked of it each time: it may have restarted, on
// another port, since the app server last asked. A proxy on this machine answers at once; one that has not answered
// within `timeoutMs` (something else holding its port, a proxy wedged) fails the ask, so a launch waiting on it ends.
export async function fetchProxyInfo(readerPort = READER_PORT, timeoutMs = 2000): Promise<ProxyInfo> {
  return ask(`http://${LOOPBACK}:${readerPort}/info`, { signal: AbortSignal.timeout(timeoutMs) }, parseProxyInfo);
}

// A new agent's recording: the proxy names and creates it, since it is the one that writes it, and the ask fails as
// fetchProxyInfo's does.
export async function requestRecording(readerPort = READER_PORT, timeoutMs = 2000): Promise<Listing> {
  return ask(`http://${LOOPBACK}:${readerPort}/recordings`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) }, parseListing);
}
