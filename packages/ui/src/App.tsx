import { useMemo } from "react";
import type { Connection } from "./connection/connection.ts";
import { exchanges, type Exchange } from "./exchanges.ts";
import { useLiveRecording, type Reading } from "./reading.ts";
import { useEvents } from "./store.ts";

export function App({ connection }: { connection: Connection }) {
  const reading = useLiveRecording(connection);
  const events = useEvents((store) => store.events);
  const shown = useMemo(() => exchanges(events), [events]);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 items-center justify-between border-b px-4">
        <h1 className="font-heading text-sm font-semibold">cc-dump</h1>
        <ReadingState reading={reading} />
      </header>
      {shown.length === 0 ? (
        <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No exchanges yet.</main>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <ol className="divide-y font-mono text-xs">
            {shown.map((exchange) => (
              <ExchangeLine key={exchange.trace_id} exchange={exchange} reading={reading.state === "reading"} />
            ))}
          </ol>
        </main>
      )}
    </div>
  );
}

// `reading`: whether the read can still bring this exchange its end.
function ExchangeLine({ exchange: { request, response, end }, reading }: { exchange: Exchange; reading: boolean }) {
  return (
    <li className="flex gap-3 px-4 py-1.5">
      {request ? (
        <span className="flex-1 truncate">
          {request.method} {request.url}
        </span>
      ) : (
        <span className="flex-1 text-muted-foreground">request not recorded</span>
      )}
      {response && (
        <span>
          {response.status} {response.reason}
        </span>
      )}
      {/* How it ended, beside its status: a response that began can still be cut, and one streaming has not ended. */}
      <span className={end?.outcome === "error" ? "text-destructive" : "text-muted-foreground"} title={end?.error}>
        {end?.outcome ?? (reading ? "pending" : "no end read")}
      </span>
    </li>
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

// An error and its causes, outermost first: a parse failure says which read it ended.
function describe(error: unknown): string {
  return error instanceof Error ? [error.message, ...(error.cause === undefined ? [] : [describe(error.cause)])].join(": ") : String(error);
}
