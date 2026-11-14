import { categories, type Category } from "../format/blocks.ts";
import { settings, useSettings, type Visibility } from "../settings.ts";
import { categoryVars } from "../theme/theme.ts";
import { Toggle } from "./Toggle.tsx";

// The filter (docs/design/01-mvp.md, F5): each category's visibility, always on screen, and the control that changes it.
export function FilterBar() {
  const visibility = useSettings((state) => state.visibility);
  return (
    <div role="group" aria-label="Categories" className="flex flex-wrap items-center gap-2">
      {categories.map((category) => (
        <CategoryToggle key={category} category={category} visibility={visibility[category]} />
      ))}
    </div>
  );
}

// A click moves the category to its next visibility.
function CategoryToggle({ category, visibility }: { category: Category; visibility: Visibility }) {
  const { next, pressed, look, does } = visibilityStates[visibility];
  return (
    <Toggle
      style={categoryVars(category)}
      data-visibility={visibility}
      pressed={pressed}
      title={`${category}: ${visibility}. Click to ${does}.`}
      className={`rounded px-2 py-0.5 font-medium ${look}`}
      onClick={() => settings.setVisibility(category, next)}
    >
      {category}
    </Toggle>
  );
}

// [LAW:dataflow-not-control-flow] Each visibility: the one a click moves to, whether the toggle is pressed, how it looks
// and what a click does. A shown category's chip is in its color, the same the gutter paints its blocks with, so the bar
// is the gutter's legend (docs/design/02-design.md); a hidden one reads as struck out and uncolored.
const visibilityStates: Record<Visibility, { next: Visibility; pressed: boolean; look: string; does: string }> = {
  shown: { next: "hidden", pressed: true, look: "bg-(--category-chip) text-(--category-chip-text)", does: "hide it" },
  hidden: { next: "shown", pressed: false, look: "text-foreground-muted line-through hover:bg-hover", does: "show it" },
};
