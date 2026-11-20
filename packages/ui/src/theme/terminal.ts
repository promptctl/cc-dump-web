import type { ITheme } from "@xterm/xterm";
import { getThemeBaseColors } from "@promptctl/rich-js/themes/registry";
import type { Theme } from "./theme.ts";

// xterm.js's names for the 16 ANSI colors, in their table order: the 8 normal, then the 8 bright.
const ansiNames = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

// The terminal in the theme (docs/design/01-features.md, F10, F13): a terminal is content, so it is on the theme's background
// in its foreground, as the conversation is, its cursor and selection are the theme's input cursor and
// selection, and the 16 ANSI colors are the theme's terminal table, rich-js's own, so what the agent prints in color is
// in the theme's colors as rich-js renders them.
export function terminalTheme({ name, palette }: Theme): ITheme {
  const { ansi } = getThemeBaseColors(name);
  return {
    background: palette.get("background").hex,
    foreground: palette.get("foreground").hex,
    cursor: palette.get("input-cursor-background").hex,
    cursorAccent: palette.get("input-cursor-foreground").hex,
    selectionBackground: palette.get("input-selection-background").hex,
    ...Object.fromEntries(ansiNames.map((color, index) => [color, ansi.get(index).hex])),
  };
}
