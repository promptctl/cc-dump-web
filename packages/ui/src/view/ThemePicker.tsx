import { useRef } from "react";
import { categories } from "../format/blocks.ts";
import { settings, useSettings } from "../settings.ts";
import { resolve, systemThemes, themeNames, themeOf, type Theme, type ThemeChoice } from "../theme/theme.ts";
import { usePrefersDark } from "../theme/useTheme.ts";
import { HeaderPopover } from "./HeaderPopover.tsx";

// The theme control (docs/design/features.md, F10): the choice in effect, and every theme to choose from, each shown
// with its ground and its category colors, so the derived colors are seen before they are chosen. The system
// choice is shown as the theme it resolves to now.
export function ThemePicker() {
  const choice = useSettings((state) => state.theme);
  const prefersDark = usePrefersDark();
  const system = themeOf(resolve("system", prefersDark));
  const theme = themeOf(resolve(choice, prefersDark));
  const list = useRef<HTMLDivElement>(null);
  const pick = (chosen: ThemeChoice) => {
    settings.setTheme(chosen);
    list.current!.hidePopover();
  };
  return (
    <HeaderPopover id="theme" popover={list} label={`Theme: ${theme.name}${choice === "system" ? " (system)" : ""}`} className="min-w-64 p-1">
      <ul>
        <Option choice="system" label={`System: ${systemThemes.dark} or ${systemThemes.light}`} swatch={system} current={choice === "system"} pick={pick} />
        {themeNames.map((name) => (
          <Option key={name} choice={name} label={name} swatch={themeOf(name)} current={choice === name} pick={pick} />
        ))}
      </ul>
    </HeaderPopover>
  );
}

function Option({ choice, label, swatch, current, pick }: { choice: ThemeChoice; label: string; swatch: Theme; current: boolean; pick: (choice: ThemeChoice) => void }) {
  return (
    <li>
      <button
        type="button"
        data-theme-choice={choice}
        aria-current={current}
        className="menu-item items-center gap-3"
        onClick={() => pick(choice)}
      >
        <Swatch theme={swatch} />
        <span>{label}</span>
      </button>
    </li>
  );
}

// A theme's ground with its category bars on it, in the filter bar's order.
function Swatch({ theme }: { theme: Theme }) {
  return (
    <span aria-hidden className="flex h-5 w-12 shrink-0 items-stretch gap-px rounded-sm p-1" style={{ background: theme.palette.get("background").hex }}>
      {categories.map((category) => (
        <span key={category} className="flex-1" style={{ background: theme.categories[category].bar.hex }} />
      ))}
    </span>
  );
}
