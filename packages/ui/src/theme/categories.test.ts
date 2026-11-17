import { contrastRatio, rgbToHsl } from "@promptctl/rich-js";
import { getThemePalette, listThemePalettes } from "@promptctl/rich-js/themes/registry";
import { describe, expect, it } from "vitest";
import { categories } from "../format/blocks.ts";
import { categoryColors } from "./categories.ts";

describe("a theme's category colors", () => {
  it.each(listThemePalettes())("%s: colors that read on the theme and apart from each other, each keeping its hue", (name) => {
    const palette = getThemePalette(name);
    const colors = categoryColors(palette);
    const background = palette.get("background");
    const surface = palette.get("surface");
    for (const category of categories) {
      const { bar, chip, chipText } = colors[category];
      expect(contrastRatio(chipText, chip), `${category} chip text`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(bar, background), `${category} bar on background`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(bar, surface), `${category} bar on surface`).toBeGreaterThanOrEqual(3);
      // The contrast slide's one silent path is to give up on a hue and answer black or white: a gray bar or chip.
      expect(rgbToHsl(bar).s, `${category} bar saturation`).toBeGreaterThan(0.1);
      expect(rgbToHsl(chip).s, `${category} chip saturation`).toBeGreaterThan(0.1);
    }
    const hues = categories.map((category) => rgbToHsl(colors[category].chip).h);
    for (const [index, hue] of hues.entries()) for (const other of hues.slice(index + 1)) expect(apart(hue, other)).toBeGreaterThanOrEqual(30);
  });

  it("gives textual-dark the original cc-dump's hues, so an eye trained on it carries over", () => {
    const colors = categoryColors(getThemePalette("textual-dark"));
    const original = { tools: 301, system: 78, http: 216, user: 353, assistant: 131, thinking: 268 } as const;
    for (const [category, hue] of Object.entries(original)) expect(apart(rgbToHsl(colors[category as keyof typeof original].chip).h, hue), category).toBeLessThanOrEqual(2);
  });
});

// The angle between two hues, the short way round.
function apart(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return Math.min(difference, 360 - difference);
}
