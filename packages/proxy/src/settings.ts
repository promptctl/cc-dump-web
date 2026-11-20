import { parseUpstream } from "./proxy.ts";
import { settingsFile } from "@cc-dump/config/settings-file";

// [LAW:one-source-of-truth] The proxy's settings (docs/design/features.md, F11): `port`, the port agents are pointed at,
// and `upstream`, the address it forwards to.
const settings = {
  port: {
    default: 3344,
    parse: (value: unknown) => {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535)
        throw new Error(`port must be an integer from 1 to 65535, got ${JSON.stringify(value)}`);
      return value as number;
    },
  },
  upstream: { default: "https://api.anthropic.com", parse: parseUpstream },
};

// Read once, at the proxy's start: a change to the file takes effect when the proxy restarts.
export const { parse: parseProxySettings, read: readProxySettings } = settingsFile("proxy settings", settings);
