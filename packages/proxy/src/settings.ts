import { Malformed } from "@cc-dump/log/failure";
import { kinds, parsed } from "@cc-dump/log/json";
import { parseUpstream, type Upstream } from "./proxy.ts";
import { settingsFile } from "@cc-dump/config/settings-file";

// [LAW:one-source-of-truth] The proxy's settings (docs/design/01-features.md, F11): `port`, the port agents are pointed at,
// and `upstream`, the address it forwards to.
type ProxySettings = { port: number; upstream: Upstream };
const port = (value: number) => {
  if (value < 1 || value > 65535) throw new Malformed(`is not from 1 to 65535: ${value}`);
  return value;
};

// Read once, at the proxy's start: a change to the file takes effect when the proxy restarts.
export const { parse: parseProxySettings, read: readProxySettings } = settingsFile<ProxySettings>(
  "proxy settings",
  { port: parsed(kinds.integer, port), upstream: parsed(kinds.string, parseUpstream) },
  { port: 3344, upstream: "https://api.anthropic.com" },
);
