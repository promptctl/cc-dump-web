import { useMemo, useState } from "react";
import type { Connection } from "./connection/connection.ts";
import { exchanges, type Exchange } from "./exchanges.ts";
import { createFormatter, type FormattedExchange } from "./format/format.ts";
import { useLiveRecording, type Reading } from "./reading.ts";
import { useProxyStatus, type StatusReading } from "./status.ts";
import { useEvents } from "./store.ts";

export function App({ connection }: { connection: Connection }) {
  const reading = useLiveRecording(connection);
  const status = useProxyStatus(connection);
  const events = useEvents((store) => store.events);
  const [format] = useState(createFormatter);
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
      {shown.length === 0 ? (
        <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No exchanges yet.</main>
      ) : (
        <main className="flex-1 overflow-y-auto">
          <ol className="divide-y font-mono text-xs">
            {shown.map((formatted) => (
              <ExchangeBlocks key={formatted.exchange.trace_id} formatted={formatted} reading={reading.state === "reading"} />
            ))}
          </ol>
        </main>
      )}
    </div>
  );
}

// An exchange's line, then each of its blocks as one line naming its category and itself.
function ExchangeBlocks({ formatted: { exchange, groups }, reading }: { formatted: FormattedExchange; reading: boolean }) {
  return (
    <li className="py-1.5">
      <ExchangeLine exchange={exchange} reading={reading} />
      {groups.map((group, index) => (
        <section key={index} className="px-4">
          <h2 className="pl-4 text-muted-foreground">{group.title}</h2>
          <ul>
            {group.blocks.map((block, index) => (
              <li key={index} className="flex gap-3 pl-8">
                <span className="w-20 text-muted-foreground">{block.category}</span>
                <span className="truncate">{block.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </li>
  );
}

// `reading`: whether the read can still bring this exchange its end.
function ExchangeLine({ exchange: { request, response, end }, reading }: { exchange: Exchange; reading: boolean }) {
  return (
    <div className="flex gap-3 px-4">
      {request.head ? (
        <span className="flex-1 truncate">
          {request.head.method} {request.head.url}
        </span>
      ) : (
        <span className="flex-1 text-muted-foreground">request not recorded</span>
      )}
      {response.head && (
        <span>
          {response.head.status} {response.head.reason}
        </span>
      )}
      {/* How it ended, beside its status: a response that began can still be cut, and one streaming has not ended. */}
      <span className={end?.outcome === "error" ? "text-destructive" : "text-muted-foreground"} title={end?.error}>
        {end?.outcome ?? (reading ? "pending" : "no end read")}
      </span>
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
