import { kinds, refined, value } from "@cc-dump/log/json";
import { parseUpstream, type Upstream } from "./proxy.ts";
import { settingsFile } from "@cc-dump/config/settings-file";

// [LAW:one-source-of-truth] The proxy's settings (docs/design/01-features.md, F11): `port`, the port agents are pointed at,
// and `upstream`, the address it forwards to.
type ProxySettings = { port: number; upstream: Upstream };

const isPort = (json: unknown): json is number => Number.isInteger(json) && (json as number) >= 1 && (json as number) <= 65535;

// Read once, at the proxy's start: a change to the file takes effect when the proxy restarts.
export const { parse: parseProxySettings, read: readProxySettings } = settingsFile<ProxySettings>(
  "proxy settings",
  { port: value({ fits: isPort, expected: "an integer from 1 to 65535" }), upstream: refined(value(kinds.string), parseUpstream) },
  { port: 3344, upstream: "https://api.anthropic.com" },
);
