import { parseRecordingName, type Listing, type RecordingKind } from "@cc-dump/proxy/format";

// [LAW:one-source-of-truth] A recording in the list, and what its name says it is, parsed once when the list arrives:
// what the list sorts by and shows is this, never a name read again. `parsed`: undefined for a file no part of the app
// named.
export type Entry = { listing: Listing; parsed: ReturnType<typeof parseRecordingName> };

// [LAW:types-are-the-program] Of two recordings that started together, an agent's comes before the proxy run's.
const kindOrder: Record<RecordingKind, number> = { agent: 0, run: 1 };

// The recordings by their start, the newest first. A file no part of the app named has no start, and comes after every
// recording that has one, in the order it was listed.
export function entriesOf(listings: Listing[]): Entry[] {
  const newestFirst = (a: Entry, b: Entry) => {
    if (a.parsed === undefined || b.parsed === undefined) return Number(a.parsed === undefined) - Number(b.parsed === undefined);
    return b.parsed.start.getTime() - a.parsed.start.getTime() || kindOrder[a.parsed.kind] - kindOrder[b.parsed.kind];
  };
  return listings.map((listing): Entry => ({ listing, parsed: parseRecordingName(listing.name) })).toSorted(newestFirst);
}
