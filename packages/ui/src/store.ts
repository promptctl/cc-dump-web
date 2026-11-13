import type { RecordedEvent } from "@cc-dump/proxy/format";
import { create } from "zustand";

// [LAW:one-source-of-truth] The events read from the recording on screen, in file order: the UI's one record of the
// traffic. Everything shown is derived from them.
export const useEvents = create<{ events: RecordedEvent[] }>(() => ({ events: [] }));

export const events = {
  reset: () => useEvents.setState({ events: [] }),
  append: (batch: RecordedEvent[]) => useEvents.setState(({ events }) => ({ events: events.concat(batch) })),
};
