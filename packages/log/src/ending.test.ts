import { describe, expect, it } from "vitest";
import { ending, requestEnding } from "./ending.ts";
import { parse } from "./json.ts";

describe("requestEnding", () => {
  const overloaded = { status: 529, reason: "Overloaded" };

  it("fails a request whose response was sent in full with an error status, by its status line", () => {
    expect(requestEnding({ outcome: "ok" }, overloaded)).toEqual({ outcome: "error", error: "529 Overloaded" });
  });

  it("is the response's ending for any other: a success, a failure reported, a cut response whatever its status, a recorded one whose head is not, which has no status to judge by", () => {
    expect(requestEnding({ outcome: "ok" }, { status: 200, reason: "OK" })).toEqual({ outcome: "ok" });
    expect(requestEnding({ outcome: "error", error: "Refused" }, overloaded)).toEqual({ outcome: "error", error: "Refused" });
    expect(requestEnding({ outcome: "aborted" }, overloaded)).toEqual({ outcome: "aborted" });
    expect(requestEnding({ outcome: "stopped" }, overloaded)).toEqual({ outcome: "stopped" });
    expect(requestEnding({ outcome: "ok" }, undefined)).toEqual({ outcome: "ok" });
  });
});

describe("ending", () => {
  it("reads each outcome, an error's with why, and refuses an error with none or an outcome this build has no variant for", () => {
    expect(parse(ending, { outcome: "stopped" }, "ended")).toEqual({ outcome: "stopped" });
    expect(parse(ending, { outcome: "error", error: "Refused" }, "ended")).toEqual({ outcome: "error", error: "Refused" });
    expect(() => parse(ending, { outcome: "error" }, "ended")).toThrow("ended: error: is missing");
    expect(() => parse(ending, { outcome: "lost" }, "ended")).toThrow("ended: outcome: is not one of ok, aborted, stopped, error");
  });
});
