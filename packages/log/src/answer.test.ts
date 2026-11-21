import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { LOOPBACK, UI_PORT } from "./address.ts";
import { admit, bodyOf, json, refusalOf, Refused, resolve, routes, type Asked, type Json, type Route, type Table } from "./answer.ts";
import { DependencyFailed, Malformed } from "./failure.ts";
import { send, serving } from "./testing.ts";
import { parseFailure } from "./wire.ts";

const PORT = 3347;
const ui = `http://${LOOPBACK}:${UI_PORT}`;

const asked = (over: Partial<Asked> = {}): Asked => ({ method: "GET", url: new URL("http://part/x"), host: `${LOOPBACK}:${PORT}`, origin: undefined, port: PORT, ...over });

// What `admit` or `resolve` refuses with, or none.
const refusal = (run: () => unknown): Refused | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refused) return error;
    throw error;
  }
  return undefined;
};

describe("the access rule", () => {
  it.each([`${LOOPBACK}:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LocalHost:${PORT}`])("admits a request for %s, the part's own address", (host) => {
    expect(refusal(() => admit(asked({ host })))).toBeUndefined();
  });

  it.each([
    ["a hostname rebound to this machine", "evil.example:3347"],
    ["a loopback name on another port", `${LOOPBACK}:3348`],
    ["a loopback name with no port", LOOPBACK],
    ["a request with no Host", undefined],
  ])("refuses %s, with or without an Origin", (_name, host) => {
    for (const origin of [undefined, ui]) expect(refusal(() => admit(asked({ host, origin })))?.status).toBe(403);
  });

  it("says that no Host was sent, not that its name is undefined", () => {
    expect(refusal(() => admit(asked({ host: undefined })))?.message).toBe("Host (none) is not an address this part is served at");
  });

  it.each([ui, `http://localhost:${UI_PORT}`, `http://[::1]:${UI_PORT}`])("admits a page served at %s", (origin) => {
    expect(refusal(() => admit(asked({ origin })))).toBeUndefined();
  });

  it.each([
    "https://example.com",
    `http://${LOOPBACK}:3000`,
    `http://${LOOPBACK}.example.com:${UI_PORT}`,
    `https://${LOOPBACK}:${UI_PORT}`,
    `http://user@${LOOPBACK}:${UI_PORT}`,
    `http://localhost.:${UI_PORT}`,
    `http://127.1:${UI_PORT}`,
    `file://${LOOPBACK}`,
    "null",
    "",
  ])("refuses a page at %j, naming it", (origin) => {
    const refused = refusal(() => admit(asked({ origin })));
    expect([refused?.status, refused?.message]).toEqual([403, `A page at ${origin} is not one this machine serves`]);
  });
});

describe("resolve", () => {
  const route: Route = () => json(null);
  const table: Table = { "/x": { GET: route, POST: route }, "/r/:name": { GET: route } };

  it("finds the route of a path and method, and its params, percent-decoded", () => {
    expect(resolve(table, admit(asked())).route).toBe(route);
    const matched = resolve(table, admit(asked({ url: new URL("http://part/r/a%20b?from=3") })));
    expect([matched.params, matched.query.get("from")]).toEqual([{ name: "a b" }, "3"]);
  });

  it.each(["/nothing", "/x/", "/r/", "/r/a/b", "/r/%zz"])("refuses a path no route has, %s, with 404", (path) => {
    expect(refusal(() => resolve(table, admit(asked({ url: new URL(`http://part${path}`) }))))?.status).toBe(404);
  });

  it.each(["PUT", "DELETE", "HEAD"])("refuses %s of a route that takes GET and POST with 405, naming what the table has", (method) => {
    const refused = refusal(() => resolve(table, admit(asked({ method }))));
    expect([refused?.status, refused?.headers]).toEqual([405, { allow: "GET, POST" }]);
  });

  it("answers an OPTIONS with the methods of the path's table entry, whatever the entry has", async () => {
    const { route } = resolve(table, admit(asked({ method: "OPTIONS", url: new URL("http://part/r/a") })));
    expect(await route(undefined as never, undefined as never, undefined as never)).toEqual({ kind: "preflight", allow: ["GET"] });
  });

  it("refuses an OPTIONS of a path no route has", () => {
    expect(refusal(() => resolve(table, admit(asked({ method: "OPTIONS", url: new URL("http://part/nothing") }))))?.status).toBe(404);
  });
});

describe("the answer to an error", () => {
  it("keeps a refusal's status and words", () => {
    expect(refusalOf(new Refused(404, "no such thing"))).toMatchObject({ status: 404, message: "no such thing" });
  });

  it("answers a dependency's failure 502, in its words", () => {
    expect(refusalOf(new DependencyFailed("the proxy is down"))).toMatchObject({ status: 502, message: "the proxy is down" });
  });

  it.each([
    ["a bug", new TypeError("x is not a function"), "x is not a function"],
    ["unreadable input, which only a body's reader answers 400", new Malformed("launch: is not JSON"), "launch: is not JSON"],
    ["an error with a cause", new Error("read failed", { cause: new Error("EISDIR") }), "read failed: EISDIR"],
  ])("answers %s as the part's own failure, 500, with its words", (_name, error, message) => {
    expect(refusalOf(error)).toMatchObject({ status: 500, message });
  });
});

describe("a request's body", () => {
  const body = (text: string) => Readable.from([text]) as unknown as IncomingMessage;

  it("is parsed", async () => {
    expect(await bodyOf(body("7"), (text) => Number(text))).toBe(7);
  });

  it("is refused 400, in the parser's words, when the parser finds it Malformed", async () => {
    const error = await bodyOf(body("x"), () => { throw new Malformed("launch: is not JSON"); }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refused);
    expect(error).toMatchObject({ status: 400, message: "launch: is not JSON" });
  });

  it("fails as the parser's own error when it is any other, which is a bug of the part's", async () => {
    const bug = new TypeError("x is not a function");
    await expect(bodyOf(body("x"), () => { throw bug; })).rejects.toBe(bug);
  });
});

describe("a part's routes", () => {
  const cycle: Record<string, Json> = {};
  cycle.self = cycle;
  const table: Table = {
    "/ok": { GET: () => json({ fine: true }) },
    "/throws": { GET: () => { throw new Error("the route broke"); } },
    "/cycle": { GET: () => json(cycle) },
  };
  const part = async () => {
    const { port, next } = await serving(routes(table));
    const failure = async (path: string, headers: Record<string, string> = {}) => {
      const res = await send(port, { path, headers });
      return { status: res.statusCode, error: parseFailure((await buffer(res)).toString()).error, type: res.headers["content-type"] };
    };
    return { port, next, failure };
  };

  it("answers every refusal as a Failure, on the request's event as a failure", async () => {
    const { failure, next } = await part();
    for (const [path, headers, status, error] of [
      ["/nothing", {}, 404, "Nothing is served at /nothing"],
      ["/ok", { origin: "https://example.com" }, 403, "A page at https://example.com is not one this machine serves"],
      ["/ok", { host: "evil.example" }, 403, "Host evil.example is not an address this part is served at"],
      ["/throws", {}, 500, "the route broke"],
    ] as const) {
      expect(await failure(path, headers)).toEqual({ status, error, type: "application/json" });
      expect(await next()).toMatchObject({ event: "request", outcome: "error", status });
    }
  });

  it("answers 500 for a body JSON cannot take, and serves the next request", async () => {
    const { port, failure, next } = await part();
    expect(await failure("/cycle")).toMatchObject({ status: 500, error: expect.stringContaining("circular") });
    expect(await next()).toMatchObject({ event: "request", outcome: "error", status: 500 });
    const ok = await send(port, { path: "/ok" });
    expect([ok.statusCode, (await buffer(ok)).toString()]).toEqual([200, '{"fine":true}']);
  });

  it("takes a request target in absolute form, as RFC 9112 has a server", async () => {
    const { port } = await part();
    const res = await send(port, { path: `http://${LOOPBACK}:${port}/ok` });
    expect([res.statusCode, (await buffer(res)).toString()]).toEqual([200, '{"fine":true}']);
  });

  it("addresses an answer to the page's own origin only, and says that it varies with it", async () => {
    const { port } = await part();
    const answered = async (headers: Record<string, string>) => {
      const res = await send(port, { path: "/ok", headers });
      res.resume();
      return [res.statusCode, res.headers["access-control-allow-origin"], res.headers.vary];
    };
    expect(await answered({ origin: ui })).toEqual([200, ui, "origin"]);
    expect(await answered({})).toEqual([200, undefined, "origin"]);
    expect(await answered({ origin: "https://example.com" })).toEqual([403, undefined, "origin"]);
  });

  it("answers an OPTIONS of a route from the table, for an admitted origin", async () => {
    const { port } = await part();
    const res = await send(port, { method: "OPTIONS", path: "/ok", headers: { origin: ui } });
    res.resume();
    expect([res.statusCode, res.headers["access-control-allow-methods"], res.headers["access-control-allow-origin"]]).toEqual([204, "GET", ui]);
  });
});
