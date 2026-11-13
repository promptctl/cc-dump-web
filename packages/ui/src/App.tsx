import { useMemo } from "react";
import type { Connection } from "./connection/connection.ts";
import { exchanges } from "./exchanges.ts";
import { createFormatter } from "./format/format.ts";
import { useLiveRecording, type Reading } from "./reading.ts";
import { useProxyStatus, type StatusReading } from "./status.ts";
import { useEvents } from "./store.ts";
import { Conversation } from "./view/Conversation.tsx";

export function App({ connection }: { connection: Connection }) {
  const reading = useLiveRecording(connection);
  const status = useProxyStatus(connection);
  const events = useEvents((store) => store.events);
  // Fast Refresh keeps state but re-runs memos, so an edit to the formatter takes effect.
  const format = useMemo(() => createFormatter(), []);
  const shown = useMemo(() => format(exchanges(events)), [format, events]);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <h1 className="font-heading text-sm font-semibold">cc-dump</h1>
        <div className="flex items-center gap-4">
          <ProxyState status={status} />
          <ReadingState reading={reading} />
        </div>
      </header>
      <Conversation formatted={shown} reading={reading.state === "reading"} />
    </div>
  );
}

function ReadingState({ reading }: { reading: Reading }) {
  switch (reading.state) {
    case "reading":
      return null;
    case "ended":
      return (
        <p className="text-xs text-muted-foreground">
          Recording ended{reading.end.unterminated_bytes > 0 && `, its last ${reading.end.unterminated_bytes} bytes cut off`}
        </p>
      );
    case "failed":
      return <p className="text-xs text-destructive">{describe(reading.error)}</p>;
  }
}

// A change to the proxy's source takes effect only when the proxy restarts (docs/design/01-mvp.md, F12).
function ProxyState({ status }: { status: StatusReading }) {
  switch (status.state) {
    case "connecting":
      return null;
    case "status": {
      if (status.status.state === "failed") {
        return <p className="text-xs text-destructive">Proxy source not watched, a restart watches it again: {status.status.message}</p>;
      }
      const changed = status.status.changed_source;
      return changed.length === 0 ? null : (
        <p className="text-xs font-medium" title={changed.join("\n")}>
          Proxy restart pending: {changed.length === 1 ? "1 source file" : `${changed.length} source files`} changed
        </p>
      );
    }
    case "failed":
      return <p className="text-xs text-destructive">{describe(status.error)}</p>;
  }
}

// An error and its causes, outermost first: a parse failure says which read it ended.
function describe(error: unknown): string {
  return error instanceof Error ? [error.message, ...(error.cause === undefined ? [] : [describe(error.cause)])].join(": ") : String(error);
}
