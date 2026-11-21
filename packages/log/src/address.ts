// [LAW:one-source-of-truth] The one address every part binds and every client dials: the IPv4 loopback address,
// written as the literal, since "localhost" resolves to ::1 as well, and a client may dial the one not bound. On macOS
// a bind to the wildcard shares a port another process holds on 127.0.0.1, which takes every connection dialed there.
// Its own module, free of node's, so the browser can import it.
export const LOOPBACK = "127.0.0.1";

// [LAW:one-source-of-truth] The port the browser opens: the UI's dev server binds it, and every part's access rule
// (answer.ts) names the origins served there as the pages it answers. It is also part of the origin the reader's
// settings are kept under (packages/proxy/src/settings.ts): a UI on another port starts from every setting's default.
export const UI_PORT = 3346;
