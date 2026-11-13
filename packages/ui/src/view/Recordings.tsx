import { recordingStart, type Listing } from "@cc-dump/proxy/format";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { describe } from "../describe.ts";
import { opening, type OpenRecording, type Reading } from "../reading.ts";
import { useView, view } from "./state.ts";

// The recordings control (docs/design/01-mvp.md, F7): the recording open, the list of every recording to open another
// from, and, while a past one is open, the way back to the live one. The list is read each time it opens, so it holds
// the runs started since it last did. `reading`: the read of the recording open, which names the one on screen.
export function Recordings({ connection, reading }: { connection: Pick<Connection, "recordings">; reading: Reading }) {
  const open = useView((state) => state.open);
  const shown = reading.state === "reading" || reading.state === "ended" ? reading.name : undefined;
  const list = useRef<HTMLDivElement>(null);
  const [listing, setListing] = useState(false);
  const pick = (opened: OpenRecording) => {
    view.open(opened);
    list.current!.hidePopover();
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      {open.recording === "past" && (
        <button type="button" data-back-to-live className="rounded-md border px-2 py-0.5 hover:bg-muted" onClick={() => view.open({ recording: "live" })}>
          Back to live
        </button>
      )}
      <button type="button" data-open-recording popoverTarget="recordings" className="rounded-md border px-2 py-0.5 hover:bg-muted">
        {open.recording === "live" ? "Live recording" : `Recording of ${startOf(open.name)}`} ▾
      </button>
      {/* The browser's popover: it closes on Escape and on a click outside it. */}
      <div
        id="recordings"
        ref={list}
        popover="auto"
        onToggle={(event) => setListing(event.newState === "open")}
        className="inset-auto top-12 right-4 m-0 max-h-[calc(100dvh-4rem)] min-w-72 overflow-y-auto rounded-md border bg-background p-1 text-xs text-foreground shadow-md"
      >
        {listing && <RecordingList connection={connection} shown={shown} pick={pick} />}
      </div>
    </div>
  );
}

// [LAW:types-are-the-program] Where the list stands: being read, read, or failed.
type Listed = { state: "listing" } | { state: "listed"; listings: Listing[] } | { state: "failed"; error: Error };

// Every recording, newest first, so the live one is on top. Read as it mounts, which is as the list opens. The one on
// screen, by its name, is not opened again: that would read it again from its start, and lose the reader's place in
// it. The live run is the one on screen only while it is the one read: after the proxy restarts, the run read is
// past, and the new one opens.
function RecordingList({ connection, shown, pick }: { connection: Pick<Connection, "recordings">; shown: string | undefined; pick: (opened: OpenRecording) => void }) {
  const [listed, setListed] = useState<Listed>({ state: "listing" });
  useEffect(() => {
    const abort = new AbortController();
    connection.recordings(abort.signal).then(
      (listings) => setListed({ state: "listed", listings }),
      // An abort rejects what it cut short; that is the list closing, not failing.
      (error: Error) => abort.signal.aborted || setListed({ state: "failed", error }),
    );
    return () => abort.abort();
  }, [connection]);
  switch (listed.state) {
    case "listing":
      return <p className="px-2 py-1 text-muted-foreground">Reading the recordings…</p>;
    case "failed":
      return <p className="px-2 py-1 text-destructive">{describe(listed.error)}</p>;
    case "listed":
      return (
        <ul>
          {listed.listings.toReversed().map((listing) => (
            <li key={listing.name}>
              <button
                type="button"
                data-recording={listing.name}
                aria-current={listing.name === shown}
                disabled={listing.name === shown}
                title={listing.name}
                className="flex w-full justify-between gap-4 rounded px-2 py-1 text-left enabled:hover:bg-muted aria-[current=true]:font-semibold"
                onClick={() => pick(opening(listing))}
              >
                <span>{startOf(listing.name)}</span>
                {listing.live && <span className="text-muted-foreground">live</span>}
              </button>
            </li>
          ))}
        </ul>
      );
  }
}

// When a recording's run started, in the reader's local time, or its name for a file no run was named.
function startOf(name: string): string {
  return recordingStart(name)?.toLocaleString() ?? name;
}
