import { getThemeBaseColors } from "@promptctl/rich-js/themes/registry";
import { describe, expect, it } from "vitest";
import { terminalTheme } from "./terminal.ts";
import { cssVariables, themeNames, themeOf } from "./theme.ts";

describe("the terminal's theme", () => {
  it("is every theme's, its ground the content's, with every one of the 16 ANSI colors as a color", () => {
    for (const name of themeNames) {
      const theme = themeOf(name);
      const terminal = terminalTheme(theme);
      expect(terminal.background).toBe(cssVariables(theme)["--background"]);
      expect(terminal.foreground).toBe(cssVariables(theme)["--foreground"]);
      const colors = Object.entries(terminal);
      expect(colors).toHaveLength(5 + 16);
      for (const [, color] of colors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("prints in the theme's own terminal colors", () => {
    const { ansi } = getThemeBaseColors("nord");
    const terminal = terminalTheme(themeOf("nord"));
    expect(terminal.red).toBe(ansi.get(1).hex);
    expect(terminal.brightWhite).toBe(ansi.get(15).hex);
  });
});
