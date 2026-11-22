import { describe, expect, it } from "vitest";
import { LOOPBACK } from "./address.ts";
import { json, Refused, routes } from "./answer.ts";
import { DependencyFailed } from "./failure.ts";
import { serving } from "./testing.ts";
import { ask, frame, isErrorStatus, parseFailure, recordingPath, ROUTES, serverSentEvents, statusLine } from "./wire.ts";

describe("serverSentEvents", () => {
  const read = (text: string) => serverSentEvents(text, true).events;

  it("reads events whatever ends their lines, and joins the lines of data", () => {
    const events = [{ id: "7", event: "message", data: "a\nb" }, { event: "end", data: "{}" }];
    expect(read("id: 7\ndata: a\ndata: b\n\nevent: end\ndata: {}\n\n")).toEqual(events);
    expect(read("id: 7\r\ndata: a\r\ndata: b\r\n\r\nevent: end\r\ndata: {}\r\n\r\n")).toEqual(events);
    expect(read("id: 7\rdata: a\rdata: b\r\revent: end\rdata: {}\r\r")).toEqual(events);
  });

  it("reads the same events however the text is cut in two", () => {
    const text = "id: 1\r\ndata: a\r\n\r\n: comment\ndata: b\n\n";
    const whole = serverSentEvents(text, true);
    for (let at = 0; at <= text.length; at++) {
      const first = serverSentEvents(text.slice(0, at), false);
      const second = serverSentEvents(first.rest + text.slice(at), true);
      expect([...first.events, ...second.events]).toEqual(whole.events);
    }
  });

  it("names an event with no event field, or an empty one, a message, and dispatches none without data", () => {
    expect(read("event:\ndata: a\n\nevent: end\n\nid: 3\n\n")).toEqual([{ event: "message", data: "a" }]);
  });

  it("drops one space after a colon, a comment line, a field it does not know, and a byte order mark at the start", () => {
    expect(read("﻿event: end\ndata:x\n: a comment\nretry: 100\n\n")).toEqual([{ event: "end", data: "x" }]);
    expect(read("data:  two\n\n")).toEqual([{ event: "message", data: " two" }]);
  });

  it("holds a CR that ends text not yet complete, since the LF of its CRLF may come next", () => {
    expect(serverSentEvents("data: a\r", false)).toEqual({ events: [], rest: "data: a\r" });
  });
});

describe("frame", () => {
  it("is read back as it was written, a value with a line break in data included", () => {
    for (const event of [{ data: "a" }, { id: "12", event: "end", data: "x: y" }, { event: "failed", data: "one\ntwo\n\nthree" }]) {
      expect(serverSentEvents(frame(event), true).events).toEqual([{ ...event, event: event.event ?? "message" }]);
    }
  });

  it("cannot end its event early with a line break in its data", () => {
    expect(serverSentEvents(frame({ data: "a\n\nb" }), true).events).toHaveLength(1);
  });
});

describe("the wire's names", () => {
  it("writes a path from the route that matches it, escaped", () => {
    expect(recordingPath("a b/c.jsonl")).toBe("/recordings/a%20b%2Fc.jsonl");
    expect(ROUTES.recording).toBe("/recordings/:name");
  });

  it("derives a status line from the status", () => {
    expect(statusLine(404)).toBe("404 Not Found");
  });

  it.each([
    [399, false],
    [400, true],
    [599, true],
    [600, false],
  ])("judges %i an error status exactly when it is a 4xx or 5xx: %s", (status, error) => {
    expect(isErrorStatus(status)).toBe(error);
  });
});

describe("ask", () => {
  const part = async () => {
    const { url } = await serving(
      routes({
        "/ok": { GET: () => json({ error: "an answer that happens to look like a failure's" }) },
        "/refused": { GET: () => { throw new Refused(404, "no such recording"); } },
        "/text": { GET: () => json("not an object") },
      }),
    );
    return url;
  };
  const text = (body: string) => body;

  it("parses the answer", async () => {
    expect(await ask(`${await part()}/ok`, {}, parseFailure)).toEqual({ error: "an answer that happens to look like a failure's" });
  });

  it("fails in the part's own words when it answers with an error status", async () => {
    const failed = await ask(`${await part()}/refused`, {}, text).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DependencyFailed);
    expect(failed).toMatchObject({ message: "no such recording" });
  });

  it("fails naming the request and the status line when the body is no Failure", async () => {
    const { url } = await serving((_req, res) => void res.writeHead(404, { "content-type": "text/plain" }).end("nope"));
    await expect(ask(`${url}/info`, {}, text)).rejects.toThrow(`GET ${url}/info: 404 Not Found`);
  });

  it("fails as the part's, naming the request, with the cause, when the answer's body is not what the parse takes", async () => {
    const url = await part();
    const failed = await ask(`${url}/text`, {}, parseFailure).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DependencyFailed);
    expect(failed).toMatchObject({ message: `GET ${url}/text`, cause: expect.any(Error) });
  });

  it("passes the parse's own bug as it is, which is not the part's failure", async () => {
    const bug = new TypeError("not a function");
    await expect(
      ask(`${await part()}/ok`, {}, () => {
        throw bug;
      }),
    ).rejects.toBe(bug);
  });

  it("fails naming the request, with the cause, when the connection fails", async () => {
    const url = `http://${LOOPBACK}:1/ok`;
    const failed = await ask(url, { method: "POST" }, text).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(DependencyFailed);
    expect(failed).toMatchObject({ message: `POST ${url}`, cause: expect.any(Error) });
  });
});
