import { describe } from "@cc-dump/log/describe";
import { levelOf, levels, type Level } from "@cc-dump/log/line";
import { useLayoutEffect, useRef } from "react";
import { parts, type Connection, type Part } from "../connection/connection.ts";
import { useLogs, type Listed, type LogConnection } from "../logs.ts";
import { settings, useSettings } from "../settings.ts";

const named: Record<Part, string> = { proxy: "proxy", server: "app server" };

// The logs panel (docs/design/01-mvp.md, F9): the proxy's and the app server's log lines as they are written, the
// latest at the bottom, those asking at least the level chosen. Each line opens to the whole of its event.
export function LogsPanel({ connection }: { connection: Pick<Connection, "logs"> }) {
  const logs = useLogs(connection);
  const least = useSettings((state) => state.logLevel);
  const shown = logs.lines.filter(({ line }) => levels.indexOf(levelOf(line.event.outcome)) <= levels.indexOf(least));
  // The list follows the latest line while it is scrolled to the bottom, and stays where the reader put it otherwise.
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [shown.length]);
  return (
    <aside aria-label="Logs" data-logs className="flex w-[32rem] shrink-0 flex-col border-l bg-surface text-xs">
      <div className="flex items-center gap-3 border-b p-3">
        <h2 className="font-semibold">Logs</h2>
        <label className="ml-auto flex items-center gap-2 text-foreground-muted">
          Showing
          <select data-log-least className="field" value={least} onChange={(event) => settings.setLogLevel(event.target.value as Level)}>
            <option value="info">everything</option>
            <option value="warn">warnings and errors</option>
            <option value="error">errors</option>
          </select>
        </label>
      </div>
      {parts.map((part) => (
        <PartState key={part} part={part} connection={logs.connections[part]} />
      ))}
      {logs.notKept > 0 ? <p className="px-3 pt-2 text-foreground-muted">{logs.notKept === 1 ? "1 line" : `${logs.notKept} lines`} not kept</p> : null}
      <ol
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto p-3 font-mono"
        onScroll={({ currentTarget: { scrollTop, scrollHeight, clientHeight } }) => (atBottom.current = scrollHeight - scrollTop - clientHeight < 2)}
      >
        {shown.map((listed) => (
          <LogRow key={`${listed.part} ${listed.line.run} ${listed.line.seq}`} listed={listed} />
        ))}
      </ol>
    </aside>
  );
}

// A part whose log the panel does not reach, and why; nothing once it does.
function PartState({ part, connection }: { part: Part; connection: LogConnection }) {
  switch (connection.state) {
    case "connected":
      return null;
    case "connecting":
      return <p className="px-3 pt-2 text-foreground-muted">Connecting to the {named[part]}'s log…</p>;
    case "dropped":
      return (
        <p data-log-connection={part} className="px-3 pt-2 text-error">
          The {named[part]}'s log is not reached, retrying
        </p>
      );
    case "failed":
      return (
        <p data-log-connection={part} className="px-3 pt-2 text-error">
          {describe(connection.error)}
        </p>
      );
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" });

// A line: when its work ended, its part, its level, its unit of work and what it says, the error first; opened, the
// whole of its event.
function LogRow({ listed: { line, ended } }: { listed: Listed }) {
  const { service, event, outcome, error, facts } = line.event;
  const level = levelOf(outcome);
  const said = error === undefined ? Object.entries(facts).filter(([name]) => name !== "trace_id").map(([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ") : error.split("\n")[0];
  return (
    <li data-log-level={level}>
      <details>
        <summary className="flex cursor-pointer gap-2 whitespace-nowrap hover:bg-hover">
          <span className="text-foreground-muted">{time.format(ended)}</span>
          <span className="w-12 shrink-0 text-foreground-muted">{service}</span>
          <span className={`w-10 shrink-0 ${levelStyle[level]}`}>{level}</span>
          <span className="shrink-0">{event}</span>
          <span className={`min-w-0 truncate ${level === "error" ? "text-error" : "text-foreground-muted"}`}>{said}</span>
        </summary>
        <div className="py-1 pl-4 *:break-all *:whitespace-pre-wrap">
          {/* The error as node wrote it, its stack on lines of their own; the rest of the event as JSON. */}
          {error === undefined ? null : <pre className="text-error">{error}</pre>}
          <pre>{JSON.stringify({ started_at: line.event.started_at, duration_ms: line.event.duration_ms, outcome, ...facts }, null, 2)}</pre>
        </div>
      </details>
    </li>
  );
}

const levelStyle: Record<Level, string> = { error: "text-error font-semibold", warn: "font-semibold", info: "text-foreground-muted" };
