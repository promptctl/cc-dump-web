import { useLayoutEffect, useSyncExternalStore } from "react";
import { useSettings } from "../settings.ts";
import { cssVariables, resolve, themeOf, type Theme } from "./theme.ts";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");
const subscribe = (onChange: () => void) => {
  const scheme = darkScheme();
  scheme.addEventListener("change", onChange);
  return () => scheme.removeEventListener("change", onChange);
};

// Whether the OS prefers a dark scheme, now and as it changes. [LAW:no-ambient-temporal-coupling] The media query is
// the one owner of that fact; React reads it through the subscription, not a copy.
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribe, () => darkScheme().matches);
}

// The theme in effect, applied to the document: the chosen one, or the system's as the OS prefers.
// [LAW:effects-at-boundaries] The one place the theme reaches the document; everything it reads is pure. A layout
// effect, so the first paint is in the theme and a change never shows a frame of the last one.
export function useTheme(): Theme {
  const choice = useSettings((state) => state.theme);
  const theme = themeOf(resolve(choice, usePrefersDark()));
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(cssVariables(theme))) root.style.setProperty(name, value);
    // The browser's own parts, scrollbars and form controls, follow the theme's side.
    root.style.colorScheme = theme.palette.dark ? "dark" : "light";
    root.dataset.theme = theme.name;
  }, [theme]);
  return theme;
}
