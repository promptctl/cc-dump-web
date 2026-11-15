import { parseRecordingName, type Listing, type RecordingKind } from "@cc-dump/proxy/format";

// [LAW:one-source-of-truth] A recording in the list, and what its name says it is, parsed once when the list arrives:
// what the list sorts by and shows is this, never a name read again. `parsed`: undefined for a file no part of the app
// named.
export type Entry = { listing: Listing; parsed: ReturnType<typeof parseRecordingName> };

// The one parse of a listing: the list's entries and the label of a recording open that the list does not hold are made
// by it.
export const entryOf = (listing: Listing): Entry => ({ listing, parsed: parseRecordingName(listing.name) });

// [LAW:types-are-the-program] Of two recordings that started together, an agent's comes before the proxy run's.
const kindOrder: Record<RecordingKind, number> = { agent: 0, run: 1 };

// [LAW:one-source-of-truth] The one order of the list, which the proxy gives none: the recordings by their start, the
// newest first. A file no part of the app named has no start, and comes after every recording that has one, by name.
export function entriesOf(listings: Listing[]): Entry[] {
  const newestFirst = (a: Entry, b: Entry) => {
    if (a.parsed === undefined || b.parsed === undefined) {
      return Number(a.parsed === undefined) - Number(b.parsed === undefined) || (a.listing.name < b.listing.name ? -1 : Number(a.listing.name > b.listing.name));
    }
    return b.parsed.start.getTime() - a.parsed.start.getTime() || kindOrder[a.parsed.kind] - kindOrder[b.parsed.kind];
  };
  return listings.map(entryOf).toSorted(newestFirst);
}
