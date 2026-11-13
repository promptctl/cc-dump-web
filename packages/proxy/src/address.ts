// [LAW:one-source-of-truth] The port agents are pointed at, and the address the proxy forwards to.
// Their own module, so other parts can import them without starting the proxy.
export const PROXY_PORT = 3344;
export const UPSTREAM = "https://api.anthropic.com";
