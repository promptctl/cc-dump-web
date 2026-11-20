import { heard } from "./keyboard.ts";

// The keys panel (docs/design/02-design.md, "Keys"): every key of the app, by the place it is heard in, each beside
// what it does. It lists the table the keys are pressed from (keyboard.ts) and takes no key itself, so one can be tried
// while its line is read.
export function KeysPanel() {
  return (
    <aside aria-label="Keys" data-keys className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-surface p-3 text-xs">
      <h2 className="font-semibold">Keys</h2>
      {Object.values(heard).map(({ where, keys }) => (
        <section key={where} className="flex flex-col gap-1">
          <h3 className="text-foreground-muted">{where}</h3>
          {/* One width for every place's chords, the longest's, so what the keys do starts in one column. */}
          <dl className="grid grid-cols-[12ch_1fr] gap-x-3 gap-y-0.5">
            {keys.map(({ chord, does }) => (
              <div key={chord} className="contents">
                <dt>
                  <kbd className="font-mono">{chord}</kbd>
                </dt>
                <dd>{does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </aside>
  );
}
