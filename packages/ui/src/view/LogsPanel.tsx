import { describe } from "@cc-dump/log/describe";
import { lineLevel, levels, type Level, type LoggedEvent } from "@cc-dump/log/line";
import { memo, useLayoutEffect, useRef } from "react";
import type { Connection } from "../connection/connection.ts";
import type { ReadLog } from "../log.ts";
import { logParts, useLogs, type Listed, type LogConnection, type LogPart } from "../logs.ts";
import { settings, useSettings } from "../settings.ts";

const named: Record<LogPart, string> = { proxy: "proxy", server: "app server", ui: "UI" };

// The logs panel (docs/design/01-features.md, F9): the proxy's, the app server's and the UI's log lines as they are
// written, the latest at the bottom, those asking at least the level chosen. Each line opens to the whole of its event.
export function LogsPanel({ connection, page }: { connection: Pick<Connection, "logs">; page: ReadLog }) {
  const logs = useLogs(connection, page);
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
  const runs = new Map<LogPart, string>();
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
      {logParts.map((part) => (
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
function PartState({ part, connection }: { part: LogPart; connection: LogConnection }) {
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

// A line: when its work ended, its part, its level, its unit of work and what it says: its error's first line, for one
// that failed, at most half the row, so the facts after it, which tell one failed request from another, are seen too;
// opened, the whole of its event, or, for a line not read, why and its text; first, when its part restarted since the
// line of it listed before, that its last process's last lines, written once the panel's connection to it was cut, did
// not reach the panel. A line is never changed once listed, so a row renders once, not again for each line after it.
export const LogRow = memo(function LogRow({ listed: { part, line, ended }, restarted }: { listed: Listed; restarted: boolean }) {
  const level = lineLevel(line);
  const { service, event, facts, error, opened } =
    "event" in line
      ? shownOf(line.event)
      : { service: named[part], event: "unread", facts: "", error: line.error, opened: line.unread };
  const headline = error?.split("\n")[0];
  return (
    <li data-log-level={level}>
      {restarted ? <p className="my-1 border-t pt-1 text-foreground-muted">The {named[part]} restarted: what its last process wrote last, its shutdown's, did not reach the panel</p> : null}
      <details>
        <summary className="flex cursor-pointer gap-2 whitespace-nowrap hover:bg-hover">
          <span className="text-foreground-muted">{"event" in line ? time.format(ended) : "—"}</span>
          <span className="w-12 shrink-0 text-foreground-muted">{service}</span>
          <span className={`w-10 shrink-0 ${levelStyle[level]}`}>{level}</span>
          <span className="shrink-0">{event}</span>
          <span className="flex min-w-0 flex-1 gap-2">
            {headline === undefined ? null : (
              <span data-log-error className={`max-w-[50%] shrink-0 truncate ${level === "error" ? "text-error" : "text-foreground-muted"}`} title={headline}>
                {headline}
              </span>
            )}
            <span data-log-facts className="min-w-0 truncate text-foreground-muted">{facts}</span>
          </span>
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

// An event as its row shows it: its facts on its line, each by its name, and, opened, every field the line has no
// place of its own for, its facts among them.
function shownOf({ service, event, error, facts, ...rest }: LoggedEvent) {
  const said = Object.entries(facts).map(([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return { service, event, error, facts: said.join(" "), opened: JSON.stringify({ ...rest, ...facts }, null, 2) };
}

const levelStyle: Record<Level, string> = { error: "text-error font-semibold", warn: "font-semibold", info: "text-foreground-muted" };
