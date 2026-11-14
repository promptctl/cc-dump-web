import { recordingStart, type Listing } from "@cc-dump/proxy/format";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { describe } from "@cc-dump/log/describe";
import { onScreen, toOpenRecording, type OpenRecording, type Reading } from "../reading.ts";
import { HeaderPopover } from "./HeaderPopover.tsx";
import { useView, view } from "./state.ts";

// The recordings control (docs/design/01-mvp.md, F7): the recording open, the list of every recording to open another
// from, and, while a past one is open, the way back to the live one. The list is read each time it opens, so it holds
// the runs started since it last did. `reading`: the read of the recording open, which names the one on screen.
export function Recordings({ connection, reading }: { connection: Pick<Connection, "recordings">; reading: Reading }) {
  const open = useView((state) => state.open);
  const shown = onScreen(reading);
  const list = useRef<HTMLDivElement>(null);
  const pick = (opened: OpenRecording) => {
    view.open(opened);
    list.current!.hidePopover();
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      {open.recording === "past" && (
        <button type="button" data-back-to-live className="control" onClick={() => view.open({ recording: "live" })}>
          Back to live
        </button>
      )}
      <HeaderPopover id="recordings" popover={list} label={open.recording === "live" ? "Live recording" : `Recording of ${startOf(open.name)}`} className="min-w-72 p-1">
        <RecordingList connection={connection} shown={shown} pick={pick} />
      </HeaderPopover>
    </div>
  );
}

// [LAW:types-are-the-program] Where the list stands: being read, read, or failed.
type Listed = { state: "listing" } | { state: "listed"; listings: Listing[] } | { state: "failed"; error: Error };

// Every recording, newest first, so the live one is on top. Read as it mounts, which is as the list opens. The one on
// screen is not opened again: that would read it again from its start, and lose the reader's place in it.
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
      return <p className="px-2 py-1 text-foreground-muted">Reading the recordings…</p>;
    case "failed":
      return <p className="px-2 py-1 text-error">{describe(listed.error)}</p>;
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
                className="menu-item justify-between gap-4"
                onClick={() => pick(toOpenRecording(listing))}
              >
                <span>{startOf(listing.name)}</span>
                {listing.live && <span className="text-foreground-muted">live</span>}
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
