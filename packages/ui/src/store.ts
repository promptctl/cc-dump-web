import type { RecordedEvent } from "@cc-dump/proxy/format";
import { create } from "zustand";

// [LAW:one-source-of-truth] The events read from the recording on screen, in file order: the UI's one record of the
// traffic. Everything shown is derived from them. `read` counts the recordings opened, each of which empties them in the
// commit that opens it (view.open): the one value that changes on every open, the recording opened again as much as
// another, so what is keyed on it begins again.
export const useEvents = create<{ events: RecordedEvent[]; read: number }>(() => ({ events: [], read: 0 }));

export const events = {
  // A recording opened: empty, and a new read.
  open: () => useEvents.setState(({ read }) => ({ events: [], read: read + 1 })),
  // A read begun empties what the last one left, and is not a new open.
  clear: () => useEvents.setState({ events: [] }),
  append: (batch: RecordedEvent[]) => useEvents.setState(({ events }) => ({ events: events.concat(batch) })),
};
