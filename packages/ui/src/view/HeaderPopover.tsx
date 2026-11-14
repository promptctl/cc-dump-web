import { useState, type ReactNode, type Ref } from "react";

// A control in the header: a button, `label`, that opens the browser's popover below it, which closes on Escape and on a
// click outside it, and scrolls within the window when it is taller. `children` are mounted while it is open, so each
// opening reads afresh what they show. `popover`: the popover itself, for a control that closes it on a choice made.
export function HeaderPopover({ id, label, className, popover, children }: { id: string; label: ReactNode; className: string; popover?: Ref<HTMLDivElement>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-open={id} popoverTarget={id} className="rounded-md border px-2 py-0.5 hover:bg-muted">
        {label} ▾
      </button>
      <div
        id={id}
        ref={popover}
        popover="auto"
        onToggle={(event) => setOpen(event.newState === "open")}
        className={`inset-auto top-12 right-4 m-0 max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-md border bg-background text-xs text-foreground shadow-md ${className}`}
      >
        {open && children}
      </div>
    </>
  );
}
