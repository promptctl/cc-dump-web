// [LAW:one-source-of-truth] The port readers of the recordings and of the proxy's status connect to. Its own module, so
// other parts can import it without starting the proxy. Not a setting: it is how every other part finds the proxy.
export const READER_PORT = 3347;
