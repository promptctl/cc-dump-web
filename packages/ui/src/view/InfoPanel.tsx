import { describe } from "@cc-dump/log/describe";
import { agentBaseUrl } from "@cc-dump/proxy/format";
import { launchSession } from "@cc-dump/server/format";
import { useState, type ReactNode } from "react";
import { version } from "../../../../package.json";
import type { Connection } from "../connection/connection.ts";
import type { StatusReading } from "../status.ts";
import { useAnswer } from "./answer.ts";
import { useView } from "./state.ts";

type Informing = Pick<Connection, "agentRecording" | "launcher">;

// The info panel (docs/design/01-mvp.md, F8): what a person needs to point an agent at the proxy by hand, and to say
// what they are looking at. Each value copies with one click. `status`: the UI's connection to the proxy, whose status
// says what the proxy is, so the panel follows the proxy across its restarts. `open`: the recording open, by name.
// `session`: the agent's session, as the latest request that names one says it.
export function InfoPanel({ connection, status, open, session }: { connection: Informing; status: StatusReading; open: string | null; session: string | undefined }) {
  const launched = useView((state) => state.terminal?.window ?? null);
  return (
    <aside aria-label="Info" data-info className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-surface p-3 text-xs">
      <h2 className="font-semibold">Info</h2>
      {status.state === "connected" ? (
        <>
          <Row label="Proxy" id="proxy">
            <Value text={status.status.info.base_url} />
          </Row>
          <AgentLine connection={connection} baseUrl={status.status.info.base_url} />
          <Row label="Upstream" id="upstream">
            <Value text={status.status.info.upstream} />
          </Row>
          <Row label="Recording" id="recording">
            {open === null ? <Absent>No recording open</Absent> : <Value text={`${status.status.info.recordings}/${open}`} />}
          </Row>
        </>
      ) : (
        <p className="text-foreground-muted">The proxy's address and recordings show once its status is read; the header says where that stands.</p>
      )}
      <Row label="Session" id="session">
        {session === undefined ? <Absent>None in the traffic</Absent> : <Value text={session} />}
      </Row>
      {/* A launch stores the session it used as the next launch's, so each one shown is read again. */}
      <LaunchSession key={launched === null ? "" : `${launched.start_time} ${launched.session_id} ${launched.window_id}`} connection={connection} />
      <Row label="Version" id="version">
        <Value text={version} />
      </Row>
    </aside>
  );
}

// The tmux session the next launch uses, read as it mounts.
function LaunchSession({ connection }: { connection: Pick<Connection, "launcher"> }) {
  const launcher = useAnswer(connection.launcher);
  return (
    <Row label="tmux session for launching" id="tmux-session">
      {launcher.state === "answered" ? (
        <Value text={launchSession(launcher.value)} />
      ) : launcher.state === "failed" ? (
        <p className="text-error">{describe(launcher.error)}</p>
      ) : (
        <Absent>Asking…</Absent>
      )}
    </Row>
  );
}

// The `ANTHROPIC_BASE_URL=…` line that gives the agent started with it a recording of its own. The recording is made as
// the line is copied, each copy a new one, so no two agents are given one line and no recording is made for an agent
// nobody starts. The line copied last stays in view, saying which recording that agent's traffic goes to.
function AgentLine({ connection, baseUrl }: { connection: Pick<Connection, "agentRecording">; baseUrl: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const line = () => connection.agentRecording().then(({ name }) => `ANTHROPIC_BASE_URL=${agentBaseUrl(baseUrl, name)}`);
  return (
    <Row label="Start an agent by hand with" id="agent-line">
      <div className="flex items-start gap-2">
        {copied === null ? (
          <span className="min-w-0 flex-1 text-foreground-muted">Copy makes a new recording and copies the line that sends an agent's traffic to it.</span>
        ) : (
          <code data-info-value className="min-w-0 flex-1 font-mono break-all">
            {copied}
          </code>
        )}
        <Copy text={line} onCopied={setCopied} />
      </div>
    </Row>
  );
}

// A labelled part of the panel.
function Row({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" data-info-row={id}>
      <span className="text-foreground-muted">{label}</span>
      {children}
    </div>
  );
}

// What stands where a row has no value.
function Absent({ children }: { children: ReactNode }) {
  return <span className="text-foreground-muted">{children}</span>;
}

// A value, and the button that copies it. A new value is a new copy: "Copied" never stands beside a value not copied.
function Value({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <code data-info-value className="min-w-0 flex-1 font-mono break-all">
        {text}
      </code>
      <Copy key={text} text={() => Promise.resolve(text)} />
    </div>
  );
}

// [LAW:types-are-the-program] Where a copy stands: not asked, copied, or failed.
type Copying = { state: "idle" } | { state: "copied" } | { state: "failed"; error: Error };

// Copies the text `text` gives to the clipboard with one click, saying that it did, or why it could not: the text not
// made, or the browser refusing the clipboard. The clipboard is given the text's promise, so text made after the click
// is still written in that click's name.
function Copy({ text, onCopied }: { text: () => Promise<string>; onCopied?: (copied: string) => void }) {
  const [copying, setCopying] = useState<Copying>({ state: "idle" });
  const copy = async () => {
    try {
      const copied = text();
      // The text's own failure is the one reported: it rejects before the clipboard's write it fails.
      const [written] = await Promise.all([copied, navigator.clipboard.write([new ClipboardItem({ "text/plain": copied })])]);
      setCopying({ state: "copied" });
      onCopied?.(written);
    } catch (error) {
      setCopying({ state: "failed", error: error as Error });
    }
  };
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" data-copy className="control" onClick={() => void copy()}>
        {copying.state === "copied" ? "Copied" : "Copy"}
      </button>
      {copying.state === "failed" ? <span className="text-error">{describe(copying.error)}</span> : null}
    </span>
  );
}
