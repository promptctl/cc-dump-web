import { describe, expect, it } from "vitest";
import { baseDirectory } from "./xdg.ts";

describe("baseDirectory", () => {
  it("is the variable's value when it is absolute, and says so", () => {
    expect(baseDirectory("XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "/x/config" }, "/home/u")).toEqual({ dir: "/x/config", from: "XDG_CONFIG_HOME" });
  });

  it.each([{}, { XDG_DATA_HOME: "" }, { XDG_DATA_HOME: "relative/share" }])("is the spec's default under home when the variable is unset, empty or relative: %j", (env) => {
    expect(baseDirectory("XDG_DATA_HOME", env, "/home/u")).toEqual({ dir: "/home/u/.local/share", from: "default" });
  });

  it("defaults the config home to .config under home", () => {
    expect(baseDirectory("XDG_CONFIG_HOME", {}, "/home/u")).toEqual({ dir: "/home/u/.config", from: "default" });
  });
});
