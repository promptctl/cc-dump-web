import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxSocketDir } from "@promptctl/tmux-control-mode-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createTmux, TmuxRefused } from "./tmux.ts";

// A tmux server of the test's own, on a socket no other server uses, with `sessions`, reading no configuration, whose
// hooks and options would be the user's (a pane-died hook that respawns a dead pane). When the test finishes the server,
// started by its first session, is killed, and the socket's file, which tmux leaves, is removed whether or not it was.
let servers = 0;
function tmuxServer(...sessions: string[]) {
  const socketPath = `cc-dump-test-${process.pid}-${++servers}`;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-f", "/dev/null", "-L", socketPath, ...args], { encoding: "utf8" });
  onTestFinished(() => {
    try {
      if (sessions.length > 0) tmux("kill-server");
    } finally {
      rmSync(join(tmuxSocketDir(), socketPath), { force: true });
    }
  });
  for (const session of sessions) tmux("new-session", "-d", "-s", session);
  return { socketPath, tmux };
}

// The app server's environment variable `name` set to `value` until the test finishes, then as it was: unset again
// when it was unset, since node keeps any value assigned to process.env as a string, undefined as "undefined".
function setEnv(name: string, value: string) {
  const was = process.env[name];
  process.env[name] = value;
  onTestFinished(() => void (was === undefined ? delete process.env[name] : (process.env[name] = was)));
}

describe("createTmux", () => {
  it("names every session on the server", async () => {
    const { socketPath } = tmuxServer("one two", "alpha");
    expect((await createTmux({ socketPath }).sessions()).sort()).toEqual(["alpha", "one two"]);
  });

  it("is refused in tmux's words when no server runs", async () => {
    const { socketPath } = tmuxServer();
    const sessions = createTmux({ socketPath }).sessions();
    await expect(sessions).rejects.toBeInstanceOf(TmuxRefused);
    await expect(sessions).rejects.toThrow(/^error connecting to .*cc-dump-test-.* \(No such file or directory\)$/);
  });

  it("leaves the attached session's environment as it was", async () => {
    const { socketPath, tmux } = tmuxServer("work");
    tmux("set-environment", "-t", "=work", "SSH_AUTH_SOCK", "/the-session's");
    setEnv("SSH_AUTH_SOCK", "/the-app-server's");
    await createTmux({ socketPath }).sessions();
    await createTmux({ socketPath }).newWindow({ session: "work", command: "true", cwd: tmpdir(), env: {} });
    expect(tmux("show-environment", "-t", "=work", "SSH_AUTH_SOCK").trim()).toBe("SSH_AUTH_SOCK=/the-session's");
  });

  it("opens a window in the session, current there, running the command in its directory with its environment", async () => {
    const { socketPath, tmux } = tmuxServer("work", "other");
    const dir = mkdtempSync(join(tmpdir(), "cc-dump-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "out");
    // Quotes, `$` and `#` reach the shell as written: tmux expands no format in the command or the environment. The
    // command stays, as an agent does, since a pane whose command succeeds closes its window, which is then not current.
    const command = `printf '%s #{session_name} %s' "$ANTHROPIC_BASE_URL" "$(pwd -P)" > out; exec sleep 60`;

    const window = await createTmux({ socketPath }).newWindow({ session: "work", command, cwd: dir, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3344/#x" } });

    expect(window).toEqual({ window_id: expect.stringMatching(/^@\d+$/), pane_id: expect.stringMatching(/^%\d+$/) });
    expect(tmux("display-message", "-p", "-t", "=work:", "#{window_id}").trim()).toBe(window.window_id);
    await vi.waitFor(() => expect(readFileSync(out, "utf8")).toBe(`http://127.0.0.1:3344/#x #{session_name} ${realpathSync(dir)}`));
  });

  it("keeps the window of a command that cannot run, its pane showing why", async () => {
    const { socketPath, tmux } = tmuxServer("work");
    const { pane_id } = await createTmux({ socketPath }).newWindow({ session: "work", command: "cc-dump-no-such-command", cwd: tmpdir(), env: {} });
    await vi.waitFor(() => expect(tmux("display-message", "-p", "-t", pane_id, "#{pane_dead}").trim()).toBe("1"));
    expect(tmux("capture-pane", "-p", "-t", pane_id)).toContain("cc-dump-no-such-command");
  });

  it("is refused, opening nothing, when no session has the name", async () => {
    const { socketPath, tmux } = tmuxServer("workshop");
    const opened = createTmux({ socketPath }).newWindow({ session: "work", command: "true", cwd: tmpdir(), env: {} });
    await expect(opened).rejects.toBeInstanceOf(TmuxRefused);
    await expect(opened).rejects.toThrow("no session named work");
    expect(tmux("list-windows", "-a").trim().split("\n")).toHaveLength(1);
  });

  it("removes the window of a command tmux was never given", async () => {
    const { socketPath, tmux } = tmuxServer("work");
    // The library refuses a NUL in the command line, after the window is open, before sending it.
    await expect(createTmux({ socketPath }).newWindow({ session: "work", command: "true\0", cwd: tmpdir(), env: {} })).rejects.toThrow(RangeError);
    expect(tmux("list-windows", "-t", "=work").trim().split("\n")).toHaveLength(1);
  });

  it("attaches from inside tmux while a window has no process yet", async () => {
    const { socketPath, tmux } = tmuxServer("work");
    tmux("new-window", "-d", "-E", "-t", "=work:");
    setEnv("TMUX", "/tmp/some-other-server,1,0");
    expect(await createTmux({ socketPath }).sessions()).toEqual(["work"]);
  });
});
