import { LOOPBACK } from "@cc-dump/log/address";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListing, parseProxyInfo, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";

// [LAW:one-source-of-truth] What the running proxy says it is, asked of it each time: it may have restarted, on
// another port, since the app server last asked. A proxy on this machine answers at once; one that has not answered
// within `timeoutMs` (something else holding its port, a proxy wedged) fails the ask, so a launch waiting on it ends.
export async function fetchProxyInfo(readerPort = READER_PORT, timeoutMs = 2000): Promise<ProxyInfo> {
  return ask("GET", readerPort, "/info", timeoutMs, parseProxyInfo);
}

// The recording the proxy made for an agent about to launch: the proxy names and creates it, since it is the one that
// writes it, and the same ask ends the same way.
export async function requestRecording(readerPort = READER_PORT, timeoutMs = 2000): Promise<Listing> {
  return ask("POST", readerPort, "/recordings", timeoutMs, parseListing);
}

async function ask<T>(method: string, readerPort: number, path: string, timeoutMs: number, parse: (json: string) => T): Promise<T> {
  const url = `http://${LOOPBACK}:${readerPort}${path}`;
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return parse(await res.text());
  } catch (error) {
    throw new Error(`${method} ${url}`, { cause: error });
  }
}
