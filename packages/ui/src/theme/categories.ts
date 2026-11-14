import { ColorRgba, ensureContrast, ensureContrastToward, hslToRgb, rgbToHsl, type Palette, type PaletteRole } from "@promptctl/rich-js";
import { categories, type Category } from "../format/blocks.ts";

// The six category colors of a theme (docs/design/02-design.md, "Themes"): the bar in the gutter beside a block, the
// chip in the filter bar's legend, and the text on the chip.
export type CategoryColors = { bar: ColorRgba; chip: ColorRgba; chipText: ColorRgba };

// Each category's place among the hues, the original cc-dump's (its filter_registry's FILTER_SPECS), so that a theme
// gives each category the color the original gave it.
const hueIndex: Record<Category, number> = { tools: 0, system: 1, metadata: 2, user: 3, assistant: 4, thinking: 5 };

// Consecutive hues this far apart are as far from each other as six hues on a circle get: at least 32.5° between any two.
const goldenAngle = 137.508;
// A theme color less saturated than this is a gray, and holds no hue to keep the categories away from.
const chromaticFloor = 0.05;
// The pole a theme's text is toward: white on a dark theme, black on a light one.
const poles = { dark: new ColorRgba(255, 255, 255), light: new ColorRgba(0, 0, 0) };

// Derived as the original cc-dump derived its gutter and chip colors (~/code/cc-dump/docs/THEME_COLOR_SYSTEM.md): the
// hues are seeded in the widest gap the theme's own hues leave, so they are where the theme is not, and placed in HSL
// as the original placed them, so textual-dark shows the original's colors. The chip sits a step from the surface
// toward the foreground, with saturation taken from the primary's. The contrast floors are then held by ensureContrast,
// which slides lightness in OKLCH and keeps the hue, in place of the original's four per-hue correction loops: the chip
// text reads on the chip at 4.5, and the bar is the chip lifted toward the theme's text pole until it reads on the
// background and then on the surface at 3, which on a dark theme is how the original's gutters looked. One pole for both
// slides, the theme's own side, so the second slide only lifts further and never undoes the first.
export function categoryColors(palette: Palette): Record<Category, CategoryColors> {
  const hsl = (role: PaletteRole) => rgbToHsl(palette.get(role));
  const surface = hsl("surface");
  const primary = hsl("primary");
  const seed = seedHue([primary, hsl("secondary"), hsl("accent")].filter(({ s }) => s > chromaticFloor).map(({ h }) => h));
  const { dark } = palette;
  const pole = dark ? poles.dark : poles.light;
  const toward = dark ? 1 : -1;
  const chipL = unit(surface.l + toward * 0.2);
  const chipTextL = unit(dark ? Math.max(chipL + 0.45, 0.8) : Math.min(chipL - 0.45, 0.2));
  const barS = clamp(primary.s * 0.9, 0.45, 0.85);
  const chipS = clamp(barS * 0.55, 0.25, 0.6);
  const chipTextS = clamp(barS * 0.25, 0.1, 0.35);
  const onBackground = palette.get("background");
  const onSurface = palette.get("surface");
  const colors = categories.map((category): [Category, CategoryColors] => {
    const h = (seed + hueIndex[category] * goldenAngle) % 360;
    const chip = hslToRgb({ h, s: chipS, l: chipL });
    const chipText = ensureContrast(hslToRgb({ h, s: chipTextS, l: chipTextL }), chip, 4.5);
    const bar = ensureContrastToward(ensureContrastToward(chip, onBackground, 3, pole), onSurface, 3, pole);
    return [category, { bar, chip, chipText }];
  });
  return Object.fromEntries(colors) as Record<Category, CategoryColors>;
}

// The hue at the middle of the widest gap between `hues` on the circle: a warm 30° when the theme has no hue, and the
// opposite of its one hue when it has one.
function seedHue(hues: number[]): number {
  const sorted = [...new Set(hues)].sort((a, b) => a - b);
  if (sorted.length === 0) return 30;
  if (sorted.length === 1) return (sorted[0]! + 180) % 360;
  const gaps = sorted.map((from, index) => {
    const to = sorted[(index + 1) % sorted.length]!;
    const gap = (to - from + 360) % 360;
    return { gap, middle: (from + gap / 2) % 360 };
  });
  return gaps.reduce((widest, gap) => (gap.gap > widest.gap ? gap : widest)).middle;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// A lightness kept off both poles, where every hue is the same black or white.
const unit = (lightness: number) => clamp(lightness, 0.05, 0.95);
