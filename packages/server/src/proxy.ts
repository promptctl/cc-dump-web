import { LOOPBACK } from "@cc-dump/log/address";
import { describe } from "@cc-dump/log/describe";
import { DependencyFailed } from "@cc-dump/log/failure";
import { ask, ROUTES } from "@cc-dump/log/wire";
import { READER_PORT } from "@cc-dump/proxy/address";
import { parseListing, parseProxyInfo, type Listing, type ProxyInfo } from "@cc-dump/proxy/format";

// [LAW:single-enforcer] The one place a failure of the proxy becomes the app server's answer: whatever `ask` fails with,
// the proxy unreachable, its refusal, an answer that is not what it says it sends, is a dependency's failure, in the proxy's
// words. A failure of the app server's own, which is not `ask`'s, is not one.
const unreached =
  (what: string) =>
  (error: unknown): never => {
    throw new DependencyFailed(`The proxy did not ${what}: ${describe(error)}`, { cause: error });
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
