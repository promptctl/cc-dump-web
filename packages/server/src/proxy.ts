import { LOOPBACK } from "@cc-dump/log/address";
import { describe } from "@cc-dump/log/describe";
import { DependencyFailed } from "@cc-dump/log/failure";
import { ask, ROUTES } from "@cc-dump/log/wire";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListing, parseProxyInfo, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";

// The proxy failing to answer, which `ask` says as a `DependencyFailed` (unreachable, its refusal, an answer that is not
// what it says it sends), is the app server's answer in the proxy's words, with what the app server asked it. A failure of
// the app server's own, which `ask` passes as it is, is not.
const unreached =
  (what: string) =>
  (error: unknown): never => {
    throw error instanceof DependencyFailed ? new DependencyFailed(`The proxy did not ${what}: ${describe(error)}`, { cause: error }) : error;
  };

// [LAW:one-source-of-truth] What the running proxy says it is, asked of it each time: it may have restarted, on
// another port, since the app server last asked. A proxy on this machine answers at once; one that has not answered
// within `timeoutMs` (something else holding its port, a proxy wedged) fails the ask, so a launch waiting on it ends.
export async function fetchProxyInfo(readerPort = READER_PORT, timeoutMs = 2000): Promise<ProxyInfo> {
  return ask(`http://${LOOPBACK}:${readerPort}${ROUTES.info}`, { signal: AbortSignal.timeout(timeoutMs) }, parseProxyInfo).catch(unreached("say where agents reach it"));
}

// A new agent's recording: the proxy names and creates it, since it is the one that writes it, and the ask fails as
// fetchProxyInfo's does.
export async function requestRecording(readerPort = READER_PORT, timeoutMs = 2000): Promise<Listing> {
  return ask(`http://${LOOPBACK}:${readerPort}${ROUTES.recordings}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs) }, parseListing).catch(unreached("make a recording for the agent"));
}
