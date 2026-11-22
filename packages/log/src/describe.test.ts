import { describe, expect, it } from "vitest";
import { asError, describe as said } from "./describe.ts";

describe("asError", () => {
  it("returns an Error as it is", () => {
    const error = new Error("broke");
    expect(asError(error)).toBe(error);
  });

  it("makes an Error of what is not one, in the words describe gives it, with the thrown value as its cause", () => {
    const thrown = { code: "EPIPE" };
    const error = asError(thrown);
    expect([error.message, error.cause]).toEqual([said(thrown), thrown]);
    expect(asError("plain").message).toBe("plain");
  });
});
