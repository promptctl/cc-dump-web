import { describe, expect, it } from "vitest";
import { isErrorStatus } from "./status.ts";

describe("isErrorStatus", () => {
  it.each([
    [100, false],
    [399, false],
    [400, true],
    [599, true],
    [99, true],
    [600, true],
    [999, true],
  ])("judges %i an error status exactly when it is a 4xx or 5xx, or invalid and so read as a 5xx: %s", (status, error) => {
    expect(isErrorStatus(status)).toBe(error);
  });
});
