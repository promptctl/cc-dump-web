import { LOOPBACK } from "@cc-dump/log/address";

// [LAW:single-enforcer] The one rule for who may reach the app server, every route's and the terminal's: a page from
// another site, which a browser lets send a POST or open a WebSocket anywhere, would run a command or type into the
// user's shell. A request passes when it has no Origin header, or when its Origin's hostname is one of loopback's
// names, on any port. "null", an opaque origin's, is not one.
export function fromThisMachine(origin: string | undefined): boolean {
  return origin === undefined || (URL.canParse(origin) && [LOOPBACK, "localhost", "[::1]"].includes(new URL(origin).hostname));
}
