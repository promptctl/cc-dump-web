import { describe } from "@cc-dump/log/describe";
import { agentBaseUrl, type ProxyInfo } from "@cc-dump/proxy/format";
import { launchSession } from "@cc-dump/server/format";
import { useCallback, useState, type ReactNode } from "react";
import { version } from "../../../../package.json";
import type { Connection } from "../connection/connection.ts";
import { useAnswer, type Answer } from "./answer.ts";

type Informing = Pick<Connection, "info" | "agentRecording" | "launcher">;

// The info panel (docs/design/01-mvp.md, F8): what a person needs to point an agent at the proxy by hand, and to say
// what they are looking at. Each value copies with one click. What it shows is read as it opens. `open`: the recording
// open, by name. `session`: the agent's session, as the latest request that names one says it.
export function InfoPanel({ connection, open, session }: { connection: Informing; open: string | null; session: string | undefined }) {
  const info = useAnswer(connection.info);
  const launcher = useAnswer(connection.launcher);
  return (
    <aside aria-label="Info" data-info className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-surface p-3 text-xs">
      <h2 className="font-semibold">Info</h2>
      <Answered answer={info}>
        {({ base_url, upstream, recordings }: ProxyInfo) => (
          <>
            <Row label="Proxy" id="proxy" value={base_url} />
            <AgentLine connection={connection} baseUrl={base_url} />
            <Row label="Upstream" id="upstream" value={upstream} />
            {open === null ? <Row label="Recording" id="recording" absent="No recording open" /> : <Row label="Recording" id="recording" value={`${recordings}/${open}`} />}
          </>
        )}
      </Answered>
      {session === undefined ? <Row label="Session" id="session" absent="None in the traffic" /> : <Row label="Session" id="session" value={session} />}
      <Answered answer={launcher}>{(read) => <Row label="tmux session for launching" id="tmux-session" value={launchSession(read)} />}</Answered>
      <Row label="Version" id="version" value={version} />
    </aside>
  );
}

// The answer to `ask`, asked as it mounts, as `children` show it.
function Asked<T>({ ask, children }: { ask: (signal: AbortSignal) => Promise<T>; children: (value: T) => ReactNode }) {
  return <Answered answer={useAnswer(ask)}>{children}</Answered>;
}

// An answer's value as `children` show it, or where it stands until there is one: tmux's own words when it has no
// server, the proxy's failure when it is not reached.
function Answered<T>({ answer, children }: { answer: Answer<T>; children: (value: T) => ReactNode }) {
  switch (answer.state) {
    case "asking":
      return <p className="text-foreground-muted">Asking…</p>;
    case "failed":
      return <p className="text-error">{describe(answer.error)}</p>;
    case "answered":
      return children(answer.value);
  }
}

// The `ANTHROPIC_BASE_URL=…` line that gives the agent started with it a recording of its own: a new recording each
// time the line is shown, and again once it is copied, so no two agents are given one line. The line copied stays
// in view, saying which recording that agent's traffic goes to.
function AgentLine({ connection, baseUrl }: { connection: Pick<Connection, "agentRecording">; baseUrl: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const ask = useCallback((signal: AbortSignal) => connection.agentRecording(signal).then(({ name }) => `ANTHROPIC_BASE_URL=${agentBaseUrl(baseUrl, name)}`), [connection, baseUrl]);
  return (
    <div className="flex flex-col gap-1">
      {/* Each line copied is the last shown under its key: the next is a new mount, which asks for a new recording. */}
      <Asked key={copied} ask={ask}>
        {(line) => <Row label="Start an agent by hand with" id="agent-line" value={line} onCopied={() => setCopied(line)} />}
      </Asked>
      {copied === null ? null : (
        <p data-agent-line-copied className="break-all text-foreground-muted">
          Copied: {copied}
        </p>
      )}
    </div>
  );
}

type Shown = { value: string; onCopied?: () => void } | { absent: string };

// A labelled value, and the button that copies it; or what stands where there is none.
function Row({ label, id, ...shown }: { label: string; id: string } & Shown) {
  return (
    <div className="flex flex-col gap-1" data-info-row={id}>
      <span className="text-foreground-muted">{label}</span>
      {"absent" in shown ? (
        <span className="text-foreground-muted">{shown.absent}</span>
      ) : (
        <div className="flex items-start gap-2">
          <code data-info-value className="min-w-0 flex-1 font-mono break-all">
            {shown.value}
          </code>
          <Copy text={shown.value} onCopied={shown.onCopied} />
        </div>
      )}
    </div>
  );
}

// [LAW:types-are-the-program] Where a copy stands: not asked, copied, or refused by the browser.
type Copying = { state: "idle" } | { state: "copied"; text: string } | { state: "failed"; error: Error };

// Copies `text` to the clipboard with one click, saying that it did, or why it could not.
function Copy({ text, onCopied }: { text: string; onCopied?: (() => void) | undefined }) {
  const [copying, setCopying] = useState<Copying>({ state: "idle" });
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopying({ state: "copied", text });
        onCopied?.();
      },
      (error: Error) => setCopying({ state: "failed", error }),
    );
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" data-copy className="control" onClick={copy}>
        {copying.state === "copied" && copying.text === text ? "Copied" : "Copy"}
      </button>
      {copying.state === "failed" ? <span className="text-error">{describe(copying.error)}</span> : null}
    </span>
  );
}
