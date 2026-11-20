import { describe } from "@cc-dump/log/describe";
import { launchSession, type Launch as LaunchAsked, type Launched, type Launcher } from "@cc-dump/server/format";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../connection/connection.ts";
import { useAnswer } from "./answer.ts";
import { HeaderPopover } from "./HeaderPopover.tsx";
import { view } from "./state.ts";

type Launching = Pick<Connection, "launcher" | "launch">;

// The launch control (docs/design/features.md, F1): the user picks a session on their tmux server and launches the agent
// command in a new window there. A launch opens the agent's recording, so the conversation is that agent's alone. What it
// starts from, the sessions and the settings the last launch asked for, is read each time it opens, so it holds the
// sessions opened since it last did. The launch is the control's, not the open popover's: one under way when it closes
// goes on, and its outcome is shown when it opens again, with no second launch to be pressed meanwhile.
export function Launch({ connection }: { connection: Launching }) {
  const mounted = useRef<AbortController>(null);
  useEffect(() => {
    const abort = new AbortController();
    mounted.current = abort;
    return () => abort.abort();
  }, []);
  const [launch, setLaunch] = useState<LaunchState>({ state: "idle" });
  const start = (asked: LaunchAsked) => {
    const { signal } = mounted.current!;
    setLaunch({ state: "launching" });
    connection.launch(asked, signal).then(
      (launched) => {
        setLaunch({ state: "launched", launched });
        view.launched(launched);
      },
      (error: Error) => signal.aborted || setLaunch({ state: "failed", error }),
    );
  };
  return (
    <div className="text-xs">
      <HeaderPopover id="launch" label="Launch" className="w-96 p-3">
        <LaunchForm connection={connection} launch={launch} start={start} />
      </HeaderPopover>
    </div>
  );
}

type Started = { launch: LaunchState; start: (asked: LaunchAsked) => void };

// [LAW:types-are-the-program] Where the launch stands.
type LaunchState = { state: "idle" } | { state: "launching" } | { state: "launched"; launched: Launched } | { state: "failed"; error: Error };

// Read as it mounts, which is as the control opens.
function LaunchForm({ connection, ...started }: { connection: Launching } & Started) {
  const read = useAnswer(connection.launcher);
  switch (read.state) {
    case "asking":
      return <p className="text-foreground-muted">Reading the tmux sessions…</p>;
    case "failed":
      // tmux's own words when it has no server or no sessions.
      return <p data-launch-unavailable className="text-error">{describe(read.error)}</p>;
    case "answered":
      return <Choice launcher={read.value} {...started} />;
  }
}

// The session and the command, starting from the settings the last launch asked for.
function Choice({ launcher, launch, start }: { launcher: Launcher } & Started) {
  const { settings, sessions } = launcher;
  const [session, setSession] = useState(() => launchSession(launcher));
  const [command, setCommand] = useState(settings.command);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    start({ session, command });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label className="flex items-center justify-between gap-2">
        <span>tmux session</span>
        <select data-launch-session className="field w-56" value={session} onChange={(event) => setSession(event.target.value)}>
          {sessions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span>Agent command</span>
        <input data-launch-command className="field w-56 font-mono" value={command} onChange={(event) => setCommand(event.target.value)} />
      </label>
      <div className="flex items-center justify-between gap-2">
        <Outcome launch={launch} />
        <button type="submit" data-launch disabled={launch.state === "launching"} className="control">
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
      return <span className="text-foreground-muted">Launching…</span>;
    case "launched":
      return (
        <span data-launched>
          Launched in {launch.launched.session}, window {launch.launched.window_id}
        </span>
      );
    case "failed":
      return <span data-launch-failed className="text-error">{describe(launch.error)}</span>;
  }
}
