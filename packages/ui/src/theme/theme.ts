import { contrastFor, type Palette } from "@promptctl/rich-js";
import { getThemePalette, listThemePalettes, type ThemeName } from "@promptctl/rich-js/themes/registry";
import type { CSSProperties } from "react";
import { categories, type Category } from "../format/blocks.ts";
import { categoryColors, type CategoryColors } from "./categories.ts";

export type { ThemeName };

// What the reader chose: a theme rich-js ships, or the system's (docs/design/02-design.md, "Themes").
export type ThemeChoice = ThemeName | "system";

export const themeNames = listThemePalettes();

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  value === "system" || (typeof value === "string" && (themeNames as readonly string[]).includes(value));

export const systemThemes = { dark: "textual-dark", light: "textual-light" } as const satisfies Record<string, ThemeName>;

// The theme a choice names, given what the OS prefers.
export function resolve(choice: ThemeChoice, prefersDark: boolean): ThemeName {
  return choice === "system" ? (prefersDark ? systemThemes.dark : systemThemes.light) : choice;
}

// A theme as the UI holds it: rich-js's palette and the category colors derived from it, together.
// [LAW:types-are-the-program] One value carries both, so nothing can pair a palette with another theme's categories.
export type Theme = { name: ThemeName; palette: Palette; categories: Record<Category, CategoryColors> };

// Derived once per name: the palette is rich-js's cached one, and the categories are a pure function of it.
const themes = new Map<ThemeName, Theme>();
export function themeOf(name: ThemeName): Theme {
  let theme = themes.get(name);
  if (theme === undefined) {
    const palette = getThemePalette(name);
    theme = { name, palette, categories: categoryColors(palette) };
    themes.set(name, theme);
  }
  return theme;
}

// The custom properties an element of `category` is styled through, `--category`, `--category-chip` and
// `--category-chip-text`, each the theme's variable for that category, so one class paints every category's gutter bar
// or chip (docs/design/02-design.md, "One bold element").
export function categoryVars(category: Category): CSSProperties {
  return { "--category": `var(--category-${category})`, "--category-chip": `var(--category-${category}-chip)`, "--category-chip-text": `var(--category-${category}-chip-text)` } as CSSProperties;
}

// [LAW:one-source-of-truth] The one table from a theme to the custom properties the stylesheet reads (index.css): every
// variable Textual generates from the theme, under Textual's name, as rich-js's palette holds them
// (docs/design/02-design.md, "Themes"), and the app's own, derived from them. theme.test.ts holds that every variable the
// stylesheet reads is here or declared there.
export function cssVariables({ palette, categories: colors }: Theme): Record<`--${string}`, string> {
  const warning = palette.get("warning");
  const warningMuted = palette.get("warning-muted");
  return {
    ...Object.fromEntries([...palette.vars].map(([role, color]) => [`--${role}`, color.hex])),
    // The search's matches: the theme's warning, muted for every match and whole for the current one, each with the text
    // on it whichever of black and white reads on it, so a match in muted text still reads.
    "--match": warningMuted.hex,
    "--match-foreground": contrastFor(warningMuted).hex,
    "--match-current": warning.hex,
    "--match-current-foreground": contrastFor(warning).hex,
    ...Object.fromEntries(
      categories.flatMap((category) => [
        [`--category-${category}`, colors[category].bar.hex],
        [`--category-${category}-chip`, colors[category].chip.hex],
        [`--category-${category}-chip-text`, colors[category].chipText.hex],
      ]),
    ),
  };
}
