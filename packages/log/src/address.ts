// [LAW:one-source-of-truth] The one address every part binds and every client dials: the IPv4 loopback address,
// written as the literal, since "localhost" resolves to ::1 as well, and a client may dial the one not bound. On macOS
// a bind to the wildcard shares a port another process holds on 127.0.0.1, which takes every connection dialed there.
// Its own module, free of node's, so the browser can import it.
export const LOOPBACK = "127.0.0.1";
