import { settings, useSettings, type SearchOptions } from "../settings.ts";
import type { Direction } from "./search.ts";
import { useView, view } from "./state.ts";
import { Toggle } from "./Toggle.tsx";

// The search bar (docs/design/01-mvp.md, F6): the query, the options that say how it is read, how many matches it has and
// which is current, and the steps to the next and the previous. Typing counts and highlights; only a step moves the
// view. Enter steps to the next match, Shift+Enter to the previous. `error`: why the query is not a valid regular
// expression, when it is not; it matches nothing, and the bar says so.
export function SearchBar({ count, ordinal, error, onStep }: { count: number; ordinal: number | undefined; error: string | undefined; onStep: (direction: Direction) => void }) {
  const query = useView((state) => state.search.query);
  const chosen = useSettings((state) => state.search);
  const tally =
    error !== undefined ? "Not a valid expression" : count === 0 ? (query === "" ? "" : "No matches") : ordinal === undefined ? `${count} ${count === 1 ? "match" : "matches"}` : `${ordinal} of ${count}`;
  return (
    <search className="flex items-center gap-2">
      <input
        type="search"
        aria-label="Search the conversation"
        aria-invalid={error !== undefined}
        title={error}
        placeholder="Search"
        className="field w-64 aria-invalid:text-error"
        value={query}
        onChange={(event) => view.search(event.target.value)}
        onKeyDown={(event) => {
          // The Enter that commits an input method's composition is typing, not a step. Safari ends the composition before
          // that Enter's keydown, which it reports with keyCode 229.
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          onStep(event.shiftKey ? "previous" : "next");
        }}
      />
      <div role="group" aria-label="Search options" className="flex items-center gap-1">
        {optionControls.map(({ option, label, name }) => (
          <Toggle
            key={option}
            data-option={option}
            pressed={chosen[option]}
            title={`${name}: ${chosen[option] ? "on" : "off"}. Click to turn it ${chosen[option] ? "off" : "on"}.`}
            className="rounded px-1.5 py-0.5 font-mono aria-pressed:bg-panel aria-[pressed=false]:text-foreground-muted aria-[pressed=false]:hover:bg-hover"
            onClick={() => settings.setSearchOption(option, !chosen[option])}
          >
            {label}
          </Toggle>
        ))}
      </div>
      {steps.map(({ direction, label, title }) => (
        <button
          key={direction}
          type="button"
          data-step={direction}
          title={title}
          disabled={count === 0}
          className="control"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onStep(direction)}
        >
          {label}
        </button>
      ))}
      {/* After the steps, so they stay where they are as the tally's width changes. */}
      <span data-tally title={error} className={`min-w-20 ${error === undefined ? "text-foreground-muted" : "text-error"}`}>
        {tally}
      </span>
    </search>
  );
}

// [LAW:one-type-per-behavior] The three options are one control, each with its glyph, as editors set them, and its name.
const optionControls: { option: keyof SearchOptions; label: string; name: string }[] = [
  { option: "caseSensitive", label: "Aa", name: "Match case" },
  { option: "wholeWord", label: "ab", name: "Match whole word" },
  { option: "regex", label: ".*", name: "Regular expression" },
];

const steps: { direction: Direction; label: string; title: string }[] = [
  { direction: "previous", label: "↑", title: "Previous match (Shift+Enter)" },
  { direction: "next", label: "↓", title: "Next match (Enter)" },
];
