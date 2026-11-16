import { categories, type Category } from "../format/blocks.ts";
import { branchPlacements, settings, useSettings, type Branches, type Unchanged, type Visibility } from "../settings.ts";
import { categoryVars } from "../theme/theme.ts";
import { Toggle } from "./Toggle.tsx";

// The filter (docs/design/01-mvp.md, F5): each category's visibility, always on screen, and the control that changes it;
// and whether the rows a step left unchanged fold.
export function FilterBar() {
  const visibility = useSettings((state) => state.visibility);
  const unchanged = useSettings((state) => state.unchanged);
  const branches = useSettings((state) => state.branches);
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div role="group" aria-label="Categories" className="flex flex-wrap items-center gap-2">
        {categories.map((category) => (
          <CategoryToggle key={category} category={category} visibility={visibility[category]} />
        ))}
      </div>
      <UnchangedToggle unchanged={unchanged} />
      <BranchesChoice branches={branches} />
    </div>
  );
}

// Where a branch is listed once its last request is behind the step shown: one of the placements, the one chosen pressed.
function BranchesChoice({ branches }: { branches: Branches }) {
  return (
    <div role="radiogroup" aria-label="Branches" className="flex items-center gap-1 font-sans text-foreground-muted">
      branches:
      {branchPlacements.map((placement) => (
        <Toggle
          key={placement}
          pressed={placement === branches}
          title={branchTitles[placement]}
          className="rounded px-1.5 py-0.5 aria-pressed:bg-panel aria-pressed:text-foreground aria-[pressed=false]:hover:bg-hover"
          onClick={() => settings.setBranches(placement)}
        >
          {placement}
        </Toggle>
      ))}
    </div>
  );
}

const branchTitles: Record<Branches, string> = {
  stay: "A branch stays where it arrived, as it was.",
  fold: "A branch folds into one row once its last request is behind the step shown.",
  step: "A branch shows only while its requests are; the step after its last shows it removed.",
};

// A click shows every unchanged row, or folds them again.
function UnchangedToggle({ unchanged }: { unchanged: Unchanged }) {
  const { next, pressed, now, does } = unchangedStates[unchanged];
  return (
    <Toggle pressed={pressed} title={`Unchanged rows: ${now}. Click to ${does}.`} className="control" onClick={() => settings.setUnchanged(next)}>
      unchanged
    </Toggle>
  );
}

// Each way unchanged rows are listed: the one a click moves to, whether the toggle is pressed, what it is and what a
// click does.
const unchangedStates: Record<Unchanged, { next: Unchanged; pressed: boolean; now: string; does: string }> = {
  fold: { next: "show", pressed: false, now: "folded", does: "show them all" },
  show: { next: "fold", pressed: true, now: "shown", does: "fold them" },
};

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
