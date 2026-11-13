import { categories, type Category } from "../format/blocks.ts";
import { settings, useSettings, type Visibility } from "../settings.ts";
import { Toggle } from "./Toggle.tsx";

// The filter bar (docs/design/01-mvp.md, F5): each category's visibility, always on screen, and the control that
// changes it.
export function FilterBar() {
  const visibility = useSettings((state) => state.visibility);
  return (
    <div role="group" aria-label="Categories" className="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
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
      data-category={category}
      data-visibility={visibility}
      pressed={pressed}
      title={`${category}: ${visibility}. Click to ${does}.`}
      className={`rounded-md border px-2 py-0.5 ${look}`}
      onClick={() => settings.setVisibility(category, next)}
    >
      {category}
    </Toggle>
  );
}

// [LAW:dataflow-not-control-flow] Each visibility: the one a click moves to, whether the toggle is pressed, how it looks
// and what a click does. A hidden category reads as struck out, so the bar alone says which are hidden.
const visibilityStates: Record<Visibility, { next: Visibility; pressed: boolean; look: string; does: string }> = {
  shown: { next: "hidden", pressed: true, look: "border-primary bg-primary text-primary-foreground", does: "hide it" },
  hidden: { next: "shown", pressed: false, look: "text-muted-foreground line-through hover:bg-muted", does: "show it" },
};
