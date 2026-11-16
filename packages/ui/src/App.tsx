import { useMemo } from "react";
import type { Connection } from "./connection/connection.ts";
import { describe } from "@cc-dump/log/describe";
import { exchanges } from "./exchanges.ts";
import { createFormatter } from "./format/format.ts";
import { useRecording, type Reading } from "./reading.ts";
import { useProxyStatus, type StatusReading } from "./status.ts";
import { useEvents } from "./store.ts";
import { useTheme } from "./theme/useTheme.ts";
import { Conversation } from "./view/Conversation.tsx";
import { Launch } from "./view/Launch.tsx";
import { Recordings } from "./view/Recordings.tsx";
import { Terminal } from "./view/Terminal.tsx";
import { useView } from "./view/state.ts";
import { ThemePicker } from "./view/ThemePicker.tsx";

export function App({ connection }: { connection: Connection }) {
  const theme = useTheme();
  const open = useView((state) => state.open);
  const tmuxWindow = useView((state) => state.window);
  const reading = useRecording(connection, open);
  const status = useProxyStatus(connection);
  const events = useEvents((store) => store.events);
  const read = useEvents((store) => store.read);
  // Fast Refresh keeps state but re-runs memos, so an edit to the formatter takes effect.
  const format = useMemo(() => createFormatter(), []);
  const shown = useMemo(() => format(exchanges(events)), [format, events]);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 items-center gap-6 border-b bg-surface px-4 text-xs">
        <h1 className="text-sm font-semibold">cc-dump</h1>
        {/* What stands now, beside the name: the proxy and the read, where the connection's status (F8) goes too. */}
        <div role="status" className="flex min-w-0 flex-1 items-center gap-4 *:min-w-0 *:truncate">
          <ProxyState status={status} />
          <ReadingState reading={reading} />
        </div>
        <div className="flex items-center gap-2">
          <Recordings connection={connection} reading={reading} />
          <Launch connection={connection} />
          <ThemePicker />
        </div>
      </header>
      {/* The conversation, and the launched agent's window beside it, each half the width (F13). */}
      <div className="flex min-h-0 flex-1">
        {/* Each opening is shown by a view of its own, mounted as a page reload mounts one, so it finds its position the
            one way (docs/design/01-mvp.md, "One path to the screen"). With no recording open there is none to show. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {open === null ? (
            <p className="p-4 text-foreground-muted">Launch an agent, or open a recording.</p>
          ) : (
            <Conversation key={read} formatted={shown} reading={reading.state === "reading"} />
          )}
        </div>
        {tmuxWindow === null ? null : <Terminal key={`${tmuxWindow.start_time} ${tmuxWindow.session_id} ${tmuxWindow.window_id}`} connection={connection} window={tmuxWindow} theme={theme} />}
      </div>
    </div>
  );
}

function ReadingState({ reading }: { reading: Reading }) {
  switch (reading.state) {
    case "none":
    case "reading":
      return null;
    case "ended":
      return (
        <p className="text-foreground-muted" title={recordingEnded(reading.end.unterminated_bytes)}>
          {recordingEnded(reading.end.unterminated_bytes)}
        </p>
      );
    case "failed":
      return <p className="text-error" title={describe(reading.error)}>{describe(reading.error)}</p>;
  }
}

// A change to the proxy's source takes effect only when the proxy restarts (docs/design/01-mvp.md, F12).
function ProxyState({ status }: { status: StatusReading }) {
  switch (status.state) {
    case "connecting":
      return null;
    case "status": {
      if (status.status.state === "failed") {
        return <p className="text-error" title={status.status.message}>Proxy source not watched, a restart watches it again: {status.status.message}</p>;
      }
      const changed = status.status.changed_source;
      return changed.length === 0 ? null : (
        <p className="font-medium" title={changed.join("\n")}>
          Proxy restart pending: {changed.length === 1 ? "1 source file" : `${changed.length} source files`} changed
        </p>
      );
    }
    case "failed":
      return <p className="text-error" title={describe(status.error)}>{describe(status.error)}</p>;
  }
}

// The end of a recording read to its end, and what of its last event was cut off.
const recordingEnded = (unterminated: number) => `Recording ended${unterminated > 0 ? `, its last ${unterminated} bytes cut off` : ""}`;
