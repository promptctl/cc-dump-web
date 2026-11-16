import { describe } from "@cc-dump/log/describe";
import { lineLevel, levels, type Level, type LoggedEvent } from "@cc-dump/log/line";
import { memo, useLayoutEffect, useRef } from "react";
import { parts, type Connection, type Part } from "../connection/connection.ts";
import { useLogs, type Listed, type LogConnection } from "../logs.ts";
import { settings, useSettings } from "../settings.ts";

const named: Record<Part, string> = { proxy: "proxy", server: "app server" };

// The logs panel (docs/design/01-mvp.md, F9): the proxy's and the app server's log lines as they are written, the
// latest at the bottom, those asking at least the level chosen. Each line opens to the whole of its event.
export function LogsPanel({ connection }: { connection: Pick<Connection, "logs"> }) {
  const logs = useLogs(connection);
  const least = useSettings((state) => state.logLevel);
  const shown = logs.lines.filter(({ line }) => levels.indexOf(lineLevel(line)) <= levels.indexOf(least));
  // The list follows the latest line while it is scrolled to the bottom, and stays where the reader put it otherwise.
  // Followed on every render, whatever changed: a line going in anywhere, or a part's state above the list shortening it.
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  });
  // The run of each part's line listed last, so a line of another run says its part restarted between them.
  const runs = new Map<Part, string>();
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
        {shown.map((listed) => {
          const before = runs.get(listed.part);
          runs.set(listed.part, listed.line.run);
          return <LogRow key={`${listed.part} ${listed.line.run} ${listed.line.seq}`} listed={listed} restarted={before !== undefined && before !== listed.line.run} />;
        })}
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
// whole of its event, or, for a line not read, why and its text; first, when its part restarted since the line of it
// listed before, that its last process's last lines, written once the panel's connection to it was cut, did not reach
// the panel. A line is never changed once listed, so a row renders once, not again for each line after it.
const LogRow = memo(function LogRow({ listed: { part, line, ended }, restarted }: { listed: Listed; restarted: boolean }) {
  const level = lineLevel(line);
  const { service, event, said, error, opened } =
    "event" in line
      ? { ...line.event, said: summary(line.event), opened: JSON.stringify({ started_at: line.event.started_at, duration_ms: line.event.duration_ms, outcome: line.event.outcome, ...line.event.facts }, null, 2) }
      : { service: named[part], event: "unread", said: line.error, error: line.error, opened: line.unread };
  return (
    <li data-log-level={level}>
      {restarted ? <p className="my-1 border-t pt-1 text-foreground-muted">The {named[part]} restarted: what its last process wrote last, its shutdown's, did not reach the panel</p> : null}
      <details>
        <summary className="flex cursor-pointer gap-2 whitespace-nowrap hover:bg-hover">
          <span className="text-foreground-muted">{"event" in line ? time.format(ended) : "—"}</span>
          <span className="w-12 shrink-0 text-foreground-muted">{service}</span>
          <span className={`w-10 shrink-0 ${levelStyle[level]}`}>{level}</span>
          <span className="shrink-0">{event}</span>
          <span className={`min-w-0 truncate ${level === "error" ? "text-error" : "text-foreground-muted"}`}>{said}</span>
        </summary>
        <div className="py-1 pl-4 *:break-all *:whitespace-pre-wrap">
          {/* The error as it was written, its stack on lines of their own; the rest of the event as JSON, or the line's text. */}
          {error === undefined ? null : <pre className="text-error">{error}</pre>}
          <pre>{opened}</pre>
        </div>
      </details>
    </li>
  );
});

// What an event says on its row: its error's first line, or its facts.
function summary({ error, facts }: LoggedEvent): string {
  return error === undefined ? Object.entries(facts).filter(([name]) => name !== "trace_id").map(([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ") : error.split("\n")[0]!;
}

const levelStyle: Record<Level, string> = { error: "text-error font-semibold", warn: "font-semibold", info: "text-foreground-muted" };
