import { LOOPBACK } from "@cc-dump/log/address";

// [LAW:single-enforcer] The one rule for who may reach the app server, every route's and the terminal's: security is a
// non-goal (docs/design/01-mvp.md), but a page from another site, which a browser lets send a POST or open a WebSocket
// anywhere, would run a command or type into the user's shell. Whether a request's Origin header, which a browser sends
// with each POST, each request across origins and each WebSocket, names a page served from this machine, as the UI is, by
// any of loopback's names. A request with none is no page's; "null", an opaque origin's, names no machine.
export function fromThisMachine(origin: string | undefined): boolean {
  return origin === undefined || (URL.canParse(origin) && [LOOPBACK, "localhost", "[::1]"].includes(new URL(origin).hostname));
}
