import { Malformed } from "@cc-dump/log/failure";
import { kinds, parsed } from "@cc-dump/log/json";
import { parseUpstream } from "./proxy.ts";
import { settingsFile } from "@cc-dump/config/settings-file";

// [LAW:one-source-of-truth] The proxy's settings (docs/design/01-features.md, F11): `port`, the port agents are pointed at,
// and `upstream`, the address it forwards to.
const settings = {
  port: {
    default: 3344,
    read: parsed(kinds.integer, (port) => {
      if (port < 1 || port > 65535) throw new Malformed(`is not from 1 to 65535: ${port}`);
      return port;
    }),
  },
  upstream: { default: "https://api.anthropic.com", read: parsed(kinds.string, parseUpstream) },
};

// Read once, at the proxy's start: a change to the file takes effect when the proxy restarts.
export const { parse: parseProxySettings, read: readProxySettings } = settingsFile("proxy settings", settings);
