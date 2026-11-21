import type { SourceStatus } from "@cc-dump/proxy/format";
import { useMemo } from "react";
import type { Connection } from "./connection/connection.ts";
import { describe } from "@cc-dump/log/describe";
import { useRecording, type Reading } from "./reading.ts";
import { settings, useSettings } from "./settings.ts";
import { ago, useNow, useProxyStatus, type StatusReading } from "./status.ts";
import { useExchanges } from "./store.ts";
import { useTheme } from "./theme/useTheme.ts";
import { Conversation } from "./view/Conversation.tsx";
import { InfoPanel } from "./view/InfoPanel.tsx";
import { appKeys, heard, useKeys, withKeys, type AppActs } from "./view/keyboard.ts";
import { KeysPanel } from "./view/KeysPanel.tsx";
import { Launch } from "./view/Launch.tsx";
import { LogsPanel } from "./view/LogsPanel.tsx";
import { Recordings } from "./view/Recordings.tsx";
import { Terminal } from "./view/Terminal.tsx";
import { useView, view } from "./view/state.ts";
import { ThemePicker } from "./view/ThemePicker.tsx";
import { Toggle } from "./view/Toggle.tsx";

export function App({ connection }: { connection: Connection }) {
  const theme = useTheme();
  const open = useView((state) => state.open);
  const terminal = useView((state) => state.terminal);
  const reading = useRecording(connection, open);
  const status = useProxyStatus(connection);
  const shown = useExchanges((store) => store.exchanges);
  const read = useExchanges((store) => store.read);
  const session = useMemo(() => shown.findLast(({ facts }) => facts.session !== undefined)?.facts.session, [shown]);
  const info = useSettings((state) => state.info);
  const logs = useSettings((state) => state.logs);
  const keys = useSettings((state) => state.keys);
  // Heard here, not in the conversation, so ? answers before a recording is open.
  useKeys(heard.app.keys, appActs);
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 items-center gap-6 border-b bg-surface px-4 text-xs">
        <h1 className="text-sm font-semibold">cc-dump</h1>
        {/* What stands now, beside the name: the connection to the proxy and its traffic (F8), then the proxy's source
            and the read. */}
        <div role="status" className="flex min-w-0 flex-1 items-center gap-4 *:min-w-0 *:truncate">
          <ProxyState status={status} />
          <ReadingState reading={reading} />
        </div>
        <div className="flex items-center gap-2">
          <Recordings connection={connection} reading={reading} />
          <Launch connection={connection} />
          <ThemePicker />
          {/* While the launched agent's window is known, its terminal is shown and put away here, as the panels are. */}
          {terminal === null ? null : (
            <Toggle pressed={terminal.shown} data-terminal-toggle className="control aria-pressed:font-semibold" onClick={() => view.showTerminal(!terminal.shown)}>
              Terminal
            </Toggle>
          )}
          <Toggle pressed={info} data-info-toggle className="control aria-pressed:font-semibold" onClick={() => settings.setInfo(!info)}>
            Info
          </Toggle>
          <Toggle pressed={logs} data-logs-toggle className="control aria-pressed:font-semibold" onClick={() => settings.setLogs(!logs)}>
            Logs
          </Toggle>
          <Toggle pressed={keys} data-keys-toggle title={withKeys("What each key does", appKeys.help)} className="control aria-pressed:font-semibold" onClick={() => settings.setKeys(!keys)}>
            Keys
          </Toggle>
        </div>
      </header>
      {/* The conversation, and the launched agent's window beside it, each half the width (F13). */}
      <div className="flex min-h-0 flex-1">
        {/* Each opening is shown by a view of its own, mounted as a page reload mounts one, so it finds its position the
            one way (docs/design/01-features.md, "One path to the screen"). With no recording open there is none to show. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {open === null ? (
            <p className="p-4 text-foreground-muted">Launch an agent, or open a recording.</p>
          ) : (
            <Conversation key={read} formatted={shown} reading={reading.state === "reading"} theme={theme} />
          )}
        </div>
        {terminal?.shown ? <Terminal key={`${terminal.window.start_time} ${terminal.window.session_id} ${terminal.window.window_id}`} connection={connection} window={terminal.window} theme={theme} /> : null}
        {/* The panels open at the right (docs/design/02-design.md, "Layout"). */}
        {info ? <InfoPanel connection={connection} status={status} open={open} session={session} /> : null}
        {logs ? <LogsPanel connection={connection} /> : null}
        {keys ? <KeysPanel /> : null}
      </div>
    </div>
  );
}

// What the app's keys act on: the keys panel, shown when it is not and put away when it is.
const appActs: AppActs = { help: () => settings.setKeys(!useSettings.getState().keys) };

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

// Whether the UI reaches the proxy, and while it does, the proxy's traffic (docs/design/01-features.md, F8) and its source (F12).
function ProxyState({ status }: { status: StatusReading }) {
  switch (status.state) {
    case "connecting":
      return <p className="text-foreground-muted">○ Connecting to the proxy…</p>;
    case "dropped":
      return (
        <p data-connection="dropped" className="text-error" title="The proxy is not answering; the connection is tried again until it does">
          ○ Proxy not reached, retrying
        </p>
      );
    case "connected": {
      const { source, traffic } = status.status;
      return (
        <>
          <p data-connection="connected">
            <span className="text-success">●</span> connected
          </p>
          {/* The traffic changes with every request and its age every second: shown, never announced. */}
          <p data-in-flight={traffic.in_flight} aria-live="off">
            {traffic.in_flight} in flight
          </p>
          {traffic.last_request === null ? <p className="text-foreground-muted">no requests yet</p> : <LastRequest at={Date.parse(traffic.last_request)} />}
          <SourceState source={source} />
        </>
      );
    }
    case "failed":
      return <p className="text-error" title={describe(status.error)}>{describe(status.error)}</p>;
  }
}

// How long ago the proxy's latest request arrived, read again each second.
function LastRequest({ at }: { at: number }) {
  const now = useNow(1000);
  return (
    <p title={new Date(at).toLocaleString()} aria-live="off">
      last {ago(at, now)}
    </p>
  );
}

// A change to the proxy's source takes effect only when the proxy restarts (docs/design/01-features.md, F12).
function SourceState({ source }: { source: SourceStatus }) {
  if (source.state === "failed") {
    return <p className="text-error" title={source.message}>Proxy source not watched, a restart watches it again: {source.message}</p>;
  }
  const changed = source.changed_source;
  return changed.length === 0 ? null : (
    <p className="font-medium" title={changed.join("\n")}>
      Proxy restart pending: {changed.length === 1 ? "1 source file" : `${changed.length} source files`} changed
    </p>
  );
}

// The end of a recording read to its end, and what of its last event was cut off.
const recordingEnded = (unterminated: number) => `Recording ended${unterminated > 0 ? `, its last ${unterminated} bytes cut off` : ""}`;
