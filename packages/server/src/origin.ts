import { LOOPBACK } from "@cc-dump/log/address";

// [LAW:single-enforcer] The one rule for who may reach the app server, every route's and the terminal's: a page from
// another site, which a browser lets send a POST or open a WebSocket anywhere, would run a command or type into the
// user's shell. A browser sends Origin with each POST, each request across origins and each WebSocket, so a request
// with none is no page's. One with an Origin passes when its hostname names this machine's loopback address, as the
// UI's does, on any port; "null", an opaque origin's, names no machine.
export function fromThisMachine(origin: string | undefined): boolean {
  return origin === undefined || (URL.canParse(origin) && [LOOPBACK, "localhost", "[::1]"].includes(new URL(origin).hostname));
}
