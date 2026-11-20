import { categories, type Category } from "../format/blocks.ts";
import { levelAfter, settings, useSettings, type Visibility } from "../settings.ts";
import { categoryVars } from "../theme/theme.ts";
import { levelKeys, withKeys } from "./keyboard.ts";
import { Toggle } from "./Toggle.tsx";

// The filter (docs/design/01-features.md, F5): each category's level and the control that changes it.
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

// A click moves the category to its next level, as a press of its key does.
function CategoryToggle({ category, visibility }: { category: Category; visibility: Visibility }) {
  const { pressed, look, shows } = visibilityStates[visibility];
  return (
    <Toggle
      style={categoryVars(category)}
      data-visibility={visibility}
      pressed={pressed}
      title={withKeys(`${category}: ${visibility}, ${shows}. Click for ${levelAfter(visibility)}.`, levelKeys[category])}
      className={`rounded border px-2 py-0.5 font-medium ${look}`}
      onClick={() => settings.stepVisibility(category)}
    >
      {category}
    </Toggle>
  );
}

// [LAW:dataflow-not-control-flow] Each level: whether the toggle is pressed, how it looks and what it shows. A listed
// category's chip is in its hue, the one the gutter paints its blocks in, so the bar is the gutter's legend
// (docs/design/02-design.md): filled while its blocks show in full, outlined while they show a line each. A hidden one
// reads as struck out and uncolored.
const visibilityStates: Record<Visibility, { pressed: boolean | "mixed"; look: string; shows: string }> = {
  hidden: { pressed: false, look: "border-transparent text-foreground-muted line-through hover:bg-hover", shows: "not listed" },
  compact: { pressed: "mixed", look: "border-(--category-chip) text-foreground hover:bg-hover", shows: "a line each" },
  expanded: { pressed: true, look: "border-(--category-chip) bg-(--category-chip) text-(--category-chip-text)", shows: "each in full" },
};
