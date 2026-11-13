import type { Direction } from "./search.ts";
import { useView, view } from "./state.ts";

// The search bar (docs/design/01-mvp.md, F6): the query, how many matches it has and which is current, and the steps to
// the next and the previous. Typing counts and highlights; only a step moves the view. Enter steps to the next match,
// Shift+Enter to the previous.
export function SearchBar({ count, ordinal, onStep }: { count: number; ordinal: number | undefined; onStep: (direction: Direction) => void }) {
  const query = useView((state) => state.search.query);
  const tally = count === 0 ? (query === "" ? "" : "No matches") : ordinal === undefined ? `${count} matches` : `${ordinal} of ${count}`;
  return (
    <search className="flex items-center gap-2 border-b px-4 py-1.5 text-xs">
      <input
        type="search"
        aria-label="Search the conversation"
        placeholder="Search"
        className="w-64 rounded-md border bg-background px-2 py-0.5"
        value={query}
        onChange={(event) => view.search(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onStep(event.shiftKey ? "previous" : "next");
        }}
      />
      <span data-tally className="min-w-24 text-muted-foreground">
        {tally}
      </span>
      {steps.map(({ direction, label, title }) => (
        <button
          key={direction}
          type="button"
          data-step={direction}
          title={title}
          disabled={count === 0}
          className="rounded-md border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onStep(direction)}
        >
          {label}
        </button>
      ))}
    </search>
  );
}

const steps: { direction: Direction; label: string; title: string }[] = [
  { direction: "previous", label: "↑", title: "Previous match (Shift+Enter)" },
  { direction: "next", label: "↓", title: "Next match (Enter)" },
];
