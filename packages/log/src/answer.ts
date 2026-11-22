import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { buffer } from "node:stream/consumers";
import { LOOPBACK, UI_PORT } from "./address.ts";
import { describe } from "./describe.ts";
import type { Handler, Work } from "./index.ts";
import { DependencyFailed, Malformed } from "./failure.ts";
import { statusLine, type FailedStatus, type Failure } from "./wire.ts";

// [LAW:single-enforcer] The one way a part answers a request over HTTP (the wire's reading side is wire.ts): the part
// keeps its route table and what each route answers, and everything every route has in common is here, once. Who may
// reach the part, which route a request is for, how an error becomes a refusal and what a refusal looks like on the
// wire, and how a stream begins are decided in this module and nowhere else, so no route can answer in a way another
// does not. The agent forwarder on the proxy's port is no route: it relays an upstream's bytes.

// What a failed request is answered with: `message` in the body as it is, and the answer's own `headers` (a 405's Allow).
export type Answer = { status: FailedStatus; message: string; headers: Readonly<Record<string, string>> };

// [LAW:types-are-the-program] The statuses of a request the part refuses, which the request itself earned; 500 and 502 are
// no refusal, they are the part's or its dependency's failure, and are answered by `refusalOf` alone.
type RefusedStatus = Exclude<FailedStatus, 500 | 502>;

// A request a part refuses: answered with `status` and `message`. A refusal is an answer, not a fault, and where it was
// made is always this layer, so it carries no stack: the request's event says it in its words, and what caused it in
// `cause`.
export class Refused extends Error implements Answer {
  override readonly name = "Refused";
  readonly status: RefusedStatus;
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: RefusedStatus, message: string, { headers = {}, cause }: { headers?: Record<string, string>; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.stack = `${this.name}: ${message}`;
    this.status = status;
    this.headers = headers;
  }
}

// [LAW:single-enforcer] The one map from an error to its answer: a refusal, as it is; a dependency failing
// (failure.ts), 502; anything else is this part failing, 500, in the error's own words.
export function refusalOf(error: unknown): Answer {
  if (error instanceof Refused) return error;
  if (error instanceof DependencyFailed) return { status: 502, message: error.message, headers: {} };
  return { status: 500, message: describe(error), headers: {} };
}

export type Method = "GET" | "POST";

// [LAW:types-are-the-program] What a route decides to answer, before it has written a byte: a refusal before the first
// byte is representable, and one after it is not. A `Stream` writes a Server-Sent Events body, which begins once the
// route has answered; its promise settles once it is done with the response, and a failure it meets as it ends is the
// request's.
export type Stream = (res: ServerResponse) => Promise<void>;

// What JSON text can say, so a body `JSON.stringify` turns into no text at all (undefined, a function) is no reply.
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Reply = { kind: "json"; body: Json } | { kind: "stream"; write: Stream };

// The answer to an OPTIONS request, which only the route table gives: the preflight of a browser's request.
type Preflight = { kind: "preflight"; allow: Method[] };

export const json = (body: Json): Reply => ({ kind: "json", body });
export const stream = (write: Stream): Reply => ({ kind: "stream", write });

// What the request's path and query gave the route: `params`, the segments a `:name` of its path matched, decoded.
export type Matched = { params: Readonly<Record<string, string>>; query: URLSearchParams };
export type Route = (req: IncomingMessage, work: Work, matched: Matched) => Reply | Promise<Reply>;

// A part's routes: by path, where a segment that begins with a colon matches any one segment, and then by method.
export type Table = Readonly<Record<string, Readonly<Partial<Record<Method, Route>>>>>;

// A request as the access rule and the route table see it. `port`: the one the request came in on.
export type Asked = { method: string; url: URL; host: string | undefined; origin: string | undefined; port: number };

// [LAW:parse-dont-validate] A request's target, as RFC 9112 has a server take one: a path and query, or an absolute URI.
export function askedOf(req: IncomingMessage): Asked {
  const target = req.url!;
  const url = URL.parse(target.startsWith("/") ? `http://part${target}` : target);
  if (url === null) throw new Refused(400, `${target} is not a request target`);
  return { method: req.method!, url, host: req.headers.host, origin: req.headers.origin, port: req.socket.localPort! };
}

// A request that passed the access rule, which nothing else can make one.
declare const admitted: unique symbol;
export type Admitted = Asked & { readonly [admitted]: true };

const LOOPBACK_NAMES = [LOOPBACK, "localhost", "[::1]"];

// [LAW:single-enforcer] The one rule for who may reach a part, every route's and the terminal's upgrade's. A page from
// another site, which a browser lets send a POST or open a WebSocket anywhere, would run a command or type into the
// user's shell, and a hostname rebound to this machine reaches a part as any other site's page would. So the Host is
// one of loopback's names with the part's own port, and the Origin, which a browser sends with each POST, each request
// across origins and each WebSocket, is one the UI is served at: http, a loopback name, the UI's port. A request with
// no Origin is not a page's write or read across origins (curl, the app server's own asks, the scripts; a page's image
// is one too, which can read nothing), and "null", an opaque origin's, names no page.
export function admit(asked: Asked): Admitted {
  const { host, origin, port } = asked;
  if (host === undefined || !LOOPBACK_NAMES.some((name) => host.toLowerCase() === `${name}:${port}`)) {
    throw new Refused(403, `Host ${host ?? "(none)"} is not an address this part is served at`);
  }
  if (origin !== undefined && !LOOPBACK_NAMES.some((name) => origin === `http://${name}:${UI_PORT}`)) {
    throw new Refused(403, `A page at ${origin} is not one this machine serves`);
  }
  return asked as Admitted;
}

// The route an admitted request is for, and what its path and query gave it. A path no route has is 404, and a method
// the path's route does not take is 405, naming the methods it takes, which an OPTIONS is answered with too: the
// preflight of a browser's request from the UI's origin.
export function resolve(table: Table, { method, url }: Admitted): Matched & { route: (...args: Parameters<Route>) => Preflight | ReturnType<Route> } {
  const segments = url.pathname.split("/");
  for (const [pattern, methods] of Object.entries(table)) {
    const params = matchPath(pattern.split("/"), segments);
    if (params === undefined) continue;
    const allow = Object.keys(methods) as Method[];
    const matched = { params, query: url.searchParams };
    if (method === "OPTIONS") return { ...matched, route: () => ({ kind: "preflight", allow }) };
    const route = Object.hasOwn(methods, method) ? methods[method as Method] : undefined;
    if (route === undefined) throw new Refused(405, `${method} is not taken at ${url.pathname}; it takes ${allow.join(", ")}`, { headers: { allow: allow.join(", ") } });
    return { ...matched, route };
  }
  throw new Refused(404, `Nothing is served at ${url.pathname}`);
}

// The params of a path of `segments` that a `pattern` of segments matches, or none. A parameter is a whole, non-empty
// segment, percent-decoded; one with a malformed escape names nothing.
function matchPath(pattern: string[], segments: string[]): Record<string, string> | undefined {
  if (pattern.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [at, part] of pattern.entries()) {
    const segment = segments[at]!;
    if (!part.startsWith(":")) {
      if (part !== segment) return undefined;
      continue;
    }
    if (segment === "") return undefined;
    try {
      params[part.slice(1)] = decodeURIComponent(segment);
    } catch (error) {
      if (error instanceof URIError) return undefined;
      throw error;
    }
  }
  return params;
}

// The body of a request, parsed. A body `parse` finds `Malformed` is the client's: refused 400, in the parser's words.
// Any other error of the parser is its own bug, and fails the request as one.
export async function bodyOf<T>(req: IncomingMessage, parse: (text: string) => T): Promise<T> {
  const text = (await buffer(req)).toString();
  try {
    return parse(text);
  } catch (error) {
    throw error instanceof Malformed ? new Refused(400, describe(error), { cause: error }) : error;
  }
}

// [LAW:single-enforcer] The one effect: a part's handler for a table of routes. Every request is admitted, resolved to
// its route, and answered with what the route decided; every error, a route's, the rule's, a missing route's, is a
// refusal written as a `Failure` body, on the request's event as on its answer.
// [LAW:nothing-unseen] No refusal is answered without `work.fail`, so none is logged as ok.
export function routes(table: Table): Handler {
  return (req, res, work) => answered(table, req, res, work);
}

async function answered(table: Table, req: IncomingMessage, res: ServerResponse, work: Work) {
  try {
    // An answer depends on the request's Origin, the access rule's refusal as much as a route's.
    res.setHeader("vary", "origin");
    const admitted = admit(askedOf(req));
    // The browser reads an answer, a refusal's too, only if it is addressed to the page's own origin.
    if (admitted.origin !== undefined) res.setHeader("access-control-allow-origin", admitted.origin);
    const { route, ...matched } = resolve(table, admitted);
    const reply = await route(req, work, matched);
    // A client that left while the route ran has no one to be answered.
    if (res.destroyed) return;
    await write(res, reply);
  } catch (error) {
    work.fail(error);
    // Nor has a client that left before the route failed: an answer begun on its closed response would put a status
    // on the request's event that no one was sent.
    if (res.destroyed) return;
    const { status, message, headers } = refusalOf(error);
    // An answer begun cannot be taken back, so a failure after it cuts the response.
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ error: message } satisfies Failure));
  }
}

async function write(res: ServerResponse, reply: Reply | Preflight) {
  switch (reply.kind) {
    case "json": {
      // Serialized before the first byte, so a body that cannot be is a failure the request is still answered with.
      const body = JSON.stringify(reply.body);
      return void res.writeHead(200, { "content-type": "application/json" }).end(body);
    }
    case "stream":
      // Flushed now, so a reader of a stream with nothing to say yet is connected before it has an event.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).flushHeaders();
      return reply.write(res);
    case "preflight":
      return void res.writeHead(204, { "access-control-allow-methods": reply.allow.join(", "), "access-control-allow-headers": "content-type" }).end();
  }
}

// [LAW:single-enforcer] The one way an upgrade is refused: answered with the refusal's status line, then closed once the answer is written,
// as ws closes one it refuses itself, and its unit of work failed with `error`. A socket already closed takes no
// answer, and the upgrade is failed all the same.
export function refuseUpgrade(socket: Duplex, work: Work, error: unknown) {
  work.fail(error);
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${statusLine(refusalOf(error).status)}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
