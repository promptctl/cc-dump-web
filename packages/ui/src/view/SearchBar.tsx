import type { Ref } from "react";
import { useSettings, type SearchOptions } from "../settings.ts";
import { conversationKeys, fieldKeys, heard, press, withKeys } from "./keyboard.ts";
import type { Direction } from "./search.ts";
import { useView, view } from "./state.ts";
import { Toggle } from "./Toggle.tsx";

// The search bar (docs/design/features.md, F6): the query, the options that say how it is read, how many matches it has and
// which is current, and the steps to the next and the previous. Typing counts and highlights; only a step moves the
// view. The field hears its own keys (keyboard.ts). `error`: why the query is not a valid regular expression, when it is
// not; it matches nothing, and the bar says so. `field`: the query's field, which the conversation's search key puts
// the cursor in.
export function SearchBar({
  count,
  ordinal,
  error,
  onStep,
  field,
}: {
  count: number;
  ordinal: number | undefined;
  error: string | undefined;
  onStep: (direction: Direction) => void;
  field: Ref<HTMLInputElement>;
}) {
  const query = useView((state) => state.search.query);
  const chosen = useSettings((state) => state.search);
  const tally =
    error !== undefined ? "Not a valid expression" : count === 0 ? (query === "" ? "" : "No matches") : ordinal === undefined ? `${count} ${count === 1 ? "match" : "matches"}` : `${ordinal} of ${count}`;
  return (
    <search className="flex items-center gap-2">
      <input
        ref={field}
        type="search"
        aria-label="Search the conversation"
        aria-invalid={error !== undefined}
        title={error}
        placeholder={withKeys("Search", conversationKeys.search)}
        className="field w-64 aria-invalid:text-error"
        value={query}
        onChange={(event) => view.search(event.target.value)}
        onKeyDown={(event) => press(heard.field.keys, event.nativeEvent, { match: onStep, leave: () => event.currentTarget.blur() })}
      />
      <div role="group" aria-label="Search options" className="flex items-center gap-1">
        {optionControls.map(({ option, label, name }) => (
          <Toggle
            key={option}
            data-option={option}
            pressed={chosen[option]}
            title={`${name}: ${chosen[option] ? "on" : "off"}. Click to turn it ${chosen[option] ? "off" : "on"}.`}
            className="rounded px-1.5 py-0.5 font-mono aria-pressed:bg-panel aria-[pressed=false]:text-foreground-muted aria-[pressed=false]:hover:bg-hover"
            onClick={() => view.searchOption(option, !chosen[option])}
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
  { direction: "previous", label: "↑", title: withKeys("Previous match", fieldKeys.previous, conversationKeys.previous) },
  { direction: "next", label: "↓", title: withKeys("Next match", fieldKeys.next, conversationKeys.next) },
];
