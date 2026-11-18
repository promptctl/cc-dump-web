import { expect, it } from "vitest";
import { tildeHome } from "./home.ts";

it("shows home and what is in it as ~, and nothing else", () => {
  expect(tildeHome("/Users/a", "/Users/a")).toBe("~");
  expect(tildeHome("/Users/a/code/cc-dump", "/Users/a")).toBe("~/code/cc-dump");
  expect(tildeHome("/Users/ab/code", "/Users/a")).toBe("/Users/ab/code");
  expect(tildeHome("/tmp/Users/a", "/Users/a")).toBe("/tmp/Users/a");
});
