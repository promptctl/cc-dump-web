import { create } from "zustand";
import type { Exchange } from "./exchanges.ts";

// [LAW:one-source-of-truth] The exchanges read from the recording on screen, in the order they began: the UI's one
// record of the traffic. Everything shown is derived from them. `read` counts the recordings opened, each of which
// empties them in the commit that opens it (view.open): the one value that changes on every open, the recording opened
// again as much as another, so what is keyed on it begins again.
export const useExchanges = create<{ exchanges: Exchange[]; read: number }>(() => ({ exchanges: [], read: 0 }));

export const recording = {
  // A recording opened: empty, and a new read.
  open: () => useExchanges.setState(({ read }) => ({ exchanges: [], read: read + 1 })),
  // What a read has read, which is not a new open.
  show: (exchanges: Exchange[]) => useExchanges.setState({ exchanges }),
};
