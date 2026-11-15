import { parseRecordingName, type Listing } from "@cc-dump/proxy/format";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { describe } from "@cc-dump/log/describe";
import { onScreen, type OpenRecording, type Reading } from "../reading.ts";
import { HeaderPopover } from "./HeaderPopover.tsx";
import { useView, view } from "./state.ts";

// The recordings control (docs/design/01-mvp.md, F7): the recording open, and the list of every recording to open
// another from. The list is read each time it opens, so it holds the agents launched since it last did. `reading`: the
// read of the recording open, which names the one on screen.
export function Recordings({ connection, reading }: { connection: Pick<Connection, "recordings">; reading: Reading }) {
  const open = useView((state) => state.open);
  const shown = onScreen(reading);
  const list = useRef<HTMLDivElement>(null);
  const pick = (opened: string) => {
    view.open(opened);
    list.current!.hidePopover();
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <HeaderPopover id="recordings" popover={list} label={labelOf(open)} className="min-w-72 p-1">
        <RecordingList connection={connection} shown={shown} pick={pick} />
      </HeaderPopover>
    </div>
  );
}

// [LAW:types-are-the-program] Where the list stands: being read, read, or failed.
type Listed = { state: "listing" } | { state: "listed"; listings: Listing[] } | { state: "failed"; error: Error };

// Every recording, newest first. Read as it mounts, which is as the list opens. The one on screen is not opened again:
// that would read it again from its start, and lose the reader's place in it.
function RecordingList({ connection, shown, pick }: { connection: Pick<Connection, "recordings">; shown: string | undefined; pick: (opened: string) => void }) {
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
          {newestFirst(listed.listings).map((listing) => (
            <li key={listing.name}>
              <button
                type="button"
                data-recording={listing.name}
                aria-current={listing.name === shown}
                disabled={listing.name === shown}
                title={listing.name}
                className="menu-item justify-between gap-4"
                onClick={() => pick(listing.name)}
              >
                <span>{startOf(listing.name)}</span>
                <span className="text-foreground-muted">{kindOf(listing.name)}</span>
              </button>
            </li>
          ))}
        </ul>
      );
  }
}

// The recordings by their start, the newest first. A file no part of the app named has no start, and comes after every
// recording that has one.
function newestFirst(listings: Listing[]): Listing[] {
  const time = ({ name }: Listing) => parseRecordingName(name)?.start.getTime() ?? 0;
  return listings.toSorted((a, b) => time(b) - time(a));
}

// When a recording started, in the reader's local time, or its name for a file no part of the app named.
function startOf(name: string): string {
  return parseRecordingName(name)?.start.toLocaleString() ?? name;
}

// What a recording is of: an agent's process, or the proxy's run, which holds the traffic no agent claimed.
function kindOf(name: string): string {
  switch (parseRecordingName(name)?.kind) {
    case "agent":
      return "agent";
    case "run":
      return "proxy run";
    case undefined:
      return "";
  }
}

// The control's label: the recording open by its start, or the control's name when none is.
function labelOf(open: OpenRecording): string {
  return open === null ? "Recordings" : `Recording of ${startOf(open)}`;
}
