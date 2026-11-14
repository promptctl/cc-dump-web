import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cssVariables, isThemeChoice, resolve, themeNames, themeOf } from "./theme.ts";

describe("the theme choice", () => {
  it("names a theme rich-js ships, or the system's, which the OS's preference resolves", () => {
    expect(isThemeChoice("system")).toBe(true);
    expect(isThemeChoice("nord")).toBe(true);
    expect(isThemeChoice("solarized")).toBe(false);
    expect(isThemeChoice(1)).toBe(false);
    expect(resolve("system", true)).toBe("textual-dark");
    expect(resolve("system", false)).toBe("textual-light");
    expect(resolve("nord", true)).toBe("nord");
    expect(resolve("nord", false)).toBe("nord");
  });

  it("is one value per theme", () => {
    expect(themeOf("nord")).toBe(themeOf("nord"));
    expect(themeOf("nord").name).toBe("nord");
  });
});

describe("the stylesheet's variables", () => {
  // [LAW:one-source-of-truth] Every `var(--…)` the stylesheet reads is set by the theme or declared by the stylesheet.
  it("are every variable index.css reads, for every theme", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const read = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name!));
    const declared = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(([, name]) => name!));
    expect(read.size).toBeGreaterThan(0);
    for (const name of themeNames) {
      const set = new Set(Object.keys(cssVariables(themeOf(name))));
      for (const variable of read) expect(set.has(variable) || declared.has(variable), `${name}: ${variable}`).toBe(true);
      for (const value of Object.values(cssVariables(themeOf(name)))) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
    }
  });
});
