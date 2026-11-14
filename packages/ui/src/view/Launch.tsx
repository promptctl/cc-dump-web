import { describe } from "@cc-dump/log/describe";
import type { Launched, Launcher } from "@cc-dump/server/format";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { HeaderPopover } from "./HeaderPopover.tsx";

type Launching = Pick<Connection, "launcher" | "launch">;

// The launch control (docs/design/01-mvp.md, F1): the user picks a session on their tmux server and launches the agent
// command in a new window there. What it starts from, the sessions and the settings the last launch asked for, is read
// each time it opens, so it holds the sessions opened since it last did.
export function Launch({ connection }: { connection: Launching }) {
  return (
    <div className="text-xs">
      <HeaderPopover id="launch" label="Launch" className="w-96 p-3">
        <LaunchForm connection={connection} />
      </HeaderPopover>
    </div>
  );
}

// [LAW:types-are-the-program] Where reading what a launch starts from stands, and where the launch stands.
type Read = { state: "reading" } | { state: "read"; launcher: Launcher } | { state: "failed"; error: Error };
type LaunchState = { state: "idle" } | { state: "launching" } | { state: "launched"; launched: Launched } | { state: "failed"; error: Error };

// Read as it mounts, which is as the control opens; a read still under way when it closes is aborted.
function LaunchForm({ connection }: { connection: Launching }) {
  const [read, setRead] = useState<Read>({ state: "reading" });
  useEffect(() => {
    const abort = new AbortController();
    connection.launcher(abort.signal).then(
      (launcher) => setRead({ state: "read", launcher }),
      // An abort rejects what it cut short; that is the control closing, not failing.
      (error: Error) => abort.signal.aborted || setRead({ state: "failed", error }),
    );
    return () => abort.abort();
  }, [connection]);
  switch (read.state) {
    case "reading":
      return <p className="text-muted-foreground">Reading the tmux sessions…</p>;
    case "failed":
      // tmux's own words when it has no server or no sessions.
      return <p data-launch-unavailable className="text-destructive">{describe(read.error)}</p>;
    case "read":
      return <Choice connection={connection} launcher={read.launcher} />;
  }
}

// The session and the command, starting from the settings the last launch asked for: its session while tmux still has it.
// A launch still under way when the control closes is aborted.
function Choice({ connection, launcher: { settings, sessions } }: { connection: Launching; launcher: Launcher }) {
  const mounted = useRef<AbortController>(null);
  useEffect(() => {
    const abort = new AbortController();
    mounted.current = abort;
    return () => abort.abort();
  }, []);
  const [session, setSession] = useState(settings.session !== null && sessions.includes(settings.session) ? settings.session : sessions[0]);
  const [command, setCommand] = useState(settings.command);
  const [launch, setLaunch] = useState<LaunchState>({ state: "idle" });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const { signal } = mounted.current!;
    setLaunch({ state: "launching" });
    connection.launch({ session, command }, signal).then(
      (launched) => setLaunch({ state: "launched", launched }),
      (error: Error) => signal.aborted || setLaunch({ state: "failed", error }),
    );
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label className="flex items-center justify-between gap-2">
        <span>tmux session</span>
        <select data-launch-session className="w-56 rounded-md border bg-background px-1 py-0.5" value={session} onChange={(event) => setSession(event.target.value)}>
          {sessions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>Agent command</span>
        <input data-launch-command className="w-56 rounded-md border bg-background px-1 py-0.5 font-mono" value={command} onChange={(event) => setCommand(event.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-2">
        <Outcome launch={launch} />
        <button type="submit" data-launch disabled={launch.state === "launching"} className="rounded-md border px-2 py-0.5 enabled:hover:bg-muted disabled:opacity-50">
          Launch
        </button>
      </div>
    </form>
  );
}

function Outcome({ launch }: { launch: LaunchState }) {
  switch (launch.state) {
    case "idle":
      return <span />;
    case "launching":
      return <span className="text-muted-foreground">Launching…</span>;
    case "launched":
      return (
        <span data-launched>
          Launched in {launch.launched.session}, window {launch.launched.window_id}
        </span>
      );
    case "failed":
      return <span data-launch-failed className="text-destructive">{describe(launch.error)}</span>;
  }
}
