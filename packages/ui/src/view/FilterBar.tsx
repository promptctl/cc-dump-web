import { categories, type Category } from "../format/blocks.ts";
import { settings, useSettings, type Visibility } from "../settings.ts";

// The filter bar (docs/design/01-mvp.md, F5): each category's visibility, always on screen, and the control that
// changes it.
export function FilterBar() {
  const visibility = useSettings((state) => state.visibility);
  return (
    <div role="toolbar" aria-label="Categories" className="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
      {categories.map((category) => (
        <CategoryToggle key={category} category={category} visibility={visibility[category]} />
      ))}
    </div>
  );
}

// A click moves the category to its next visibility. As the conversation's follow control, a click takes no focus, so
// End and Space still scroll the conversation.
function CategoryToggle({ category, visibility }: { category: Category; visibility: Visibility }) {
  const { next, pressed, look, does } = visibilities[visibility];
  return (
    <button
      type="button"
      data-category={category}
      data-visibility={visibility}
      aria-pressed={pressed}
      title={`${category}: ${visibility}. Click to ${does}.`}
      className={`rounded-md border px-2 py-0.5 ${look}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => settings.setVisibility(category, next)}
    >
      {category}
    </button>
  );
}

// [LAW:dataflow-not-control-flow] Each visibility: the one a click moves to, whether the toggle is pressed, how it looks
// and what a click does. A hidden category reads as struck out, so the bar alone says which are hidden.
const visibilities: Record<Visibility, { next: Visibility; pressed: boolean; look: string; does: string }> = {
  shown: { next: "hidden", pressed: true, look: "border-primary bg-primary text-primary-foreground", does: "hide it" },
  hidden: { next: "shown", pressed: false, look: "text-muted-foreground line-through hover:bg-muted", does: "show it" },
};
