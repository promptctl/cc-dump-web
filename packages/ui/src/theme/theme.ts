import { contrastFor, type Palette, type PaletteRole } from "@promptctl/rich-js";
import { getThemePalette, listThemePalettes, type ThemeName } from "@promptctl/rich-js/themes/registry";
import { categories, type Category } from "../format/blocks.ts";
import { categoryColors, type CategoryColors } from "./categories.ts";

export type { ThemeName };

// What the reader chose (docs/design/01-mvp.md, F10): a theme rich-js ships, or the system's, which is the dark or the
// light Textual theme as the OS prefers.
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
  const theme = themes.get(name) ?? { name, palette: getThemePalette(name), categories: categoryColors(getThemePalette(name)) };
  themes.set(name, theme);
  return theme;
}

// [LAW:one-source-of-truth] The one table from a theme's roles and category colors to the custom properties the
// stylesheet reads (index.css); theme.test.ts holds that every variable the stylesheet reads is here or declared there.
export function cssVariables({ palette, categories: colors }: Theme): Record<`--${string}`, string> {
  const role = (name: PaletteRole) => palette.get(name).hex;
  const warning = palette.get("warning");
  return {
    "--background": role("background"),
    "--foreground": role("foreground"),
    "--foreground-muted": role("foreground-muted"),
    "--surface": role("surface"),
    "--panel": role("panel"),
    "--primary": role("primary"),
    "--text-error": role("text-error"),
    // The search's matches: the theme's warning, muted for every match and whole for the current one, whose text is
    // whichever of black and white reads on it.
    "--match": role("warning-muted"),
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
