import type { RecordedEvent } from "@cc-dump/proxy/format";
import { create } from "zustand";

// [LAW:one-source-of-truth] The events read from the recording on screen, in file order: the UI's one record of the
// traffic. Everything shown is derived from them. `read` counts the times they were emptied for a new start: each read
// begun, and each recording opened, whose events are emptied in the commit that opens it (view.open).
export const useEvents = create<{ events: RecordedEvent[]; read: number }>(() => ({ events: [], read: 0 }));

export const events = {
  reset: () => useEvents.setState(({ read }) => ({ events: [], read: read + 1 })),
  append: (batch: RecordedEvent[]) => useEvents.setState(({ events }) => ({ events: events.concat(batch) })),
};
