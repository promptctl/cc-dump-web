---
name: run-cc-dump
description: Run, start, drive, and screenshot cc-dump (the proxy + server + web UI that records Claude Code's API traffic). Use when asked to start the app, open a recording in the UI, take a screenshot, check a UI change in the real app, send fake agent traffic through the proxy, or run the tests.
---

cc-dump is three node processes started by `pnpm dev` — proxy (3344, reader on 3347), app server (3345), Vite UI (3346) —
and a browser UI. Drive the UI with `.claude/skills/run-cc-dump/driver.mjs` (headless Chrome via playwright-core, commands
on stdin). Generate traffic with `traffic.mjs` against `fake-anthropic.mjs`, so nothing reaches or bills the real API.
All paths are relative to the repo (or worktree) root.

## Prerequisites (macOS, verified)

Node ≥ 26, pnpm 11, tmux, Google Chrome in /Applications. The driver's one dependency lives outside the repo:

```bash
(mkdir -p ~/.cache/run-cc-dump && cd ~/.cache/run-cc-dump && npm init -y && npm install playwright-core)
pnpm install
```

## First: is a cc-dump already running?

The server, UI and reader ports (3345-3347) are constants in `packages/*/src/address.ts`, not settings, so **only one
stack can run per machine**. (3344 is the default of the proxy's `port` setting.) Other worktrees here often have one
up, sometimes observing a live Claude Code. Check before anything else:

```bash
.claude/skills/run-cc-dump/stack.sh status
```

- Ports held by another worktree's stack → **do not stop it**; drive it as-is with the driver (read-only flows are
  safe), or use the isolated proxy below for traffic. It runs *that worktree's* code, not yours. `traffic.mjs` refuses
  it unless its upstream is the fake.
- Ports free → `stack.sh up` (next section).

## Run (agent path)

### Start a stack with scratch data and a fake upstream

```bash
.claude/skills/run-cc-dump/stack.sh up      # tmux session run-cc-dump-<worktree>: windows "fake" and "dev"
.claude/skills/run-cc-dump/stack.sh logs    # the fake's log, and the interleaved proxy/server/ui log
.claude/skills/run-cc-dump/stack.sh down    # this worktree's session only
```

`up` sets `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under `/tmp/cc-dump-run` (override with `CC_DUMP_HOME`) and writes a
`proxy.json` there pointing upstream at the fake on 3399; the logs are `fake.log` and `dev.log` there. A start that is
not up in 60s kills its session and prints both logs.
Its refusal when ports are held is verified; the start itself has **not** been run yet (ports were held throughout
the sessions that wrote this) — if it fails, fix the script and this line.

### Put traffic in it

```bash
node .claude/skills/run-cc-dump/traffic.mjs 3
```

Asks the reader (`CC_DUMP_READER_PORT`, default 3347) for the proxy's `/info` and refuses unless `fake-anthropic.mjs`
answers at its upstream; then creates an agent recording (`POST /recordings`, what Launch does) and plays 3 streaming turns through
the proxy under `/agent/<recording-stem>/v1/messages`, failing on any non-2xx. Each reply has a thinking block and a
text block echoing the user turn.

### Drive the UI

```bash
node .claude/skills/run-cc-dump/driver.mjs <<'EOF'
open
click [data-open=recordings]
click [data-recording]
wait [aria-current=step]
text [aria-label="Steps"]
click [title^="system:"]
fill [aria-label="Search the conversation"] | again
text [data-tally]
click [title="The step before (←)"]
ss after-flow
errors
EOF
```

Screenshots land in `/tmp/cc-dump-shots/<name>.png` (`CC_DUMP_SHOTS` to change) — Read them to look. Commands:
`open [path]`, `ss <name>`, `click <sel>`, `fill <sel> | <text>`, `press <key>`, `wait <sel>`, `text [sel]`,
`count <sel>`, `eval <js>`, `sleep <ms>`, `errors`; the argument is the rest of the line as written. Selectors are
Playwright's; one browser session per heredoc, so
state (open recording, filters) does not carry between runs. Exit code 1 if any command printed `ERR`.

Stable selectors (from `packages/ui/src/view/`):

| Thing | Selector |
|---|---|
| Recordings menu / Launch menu / theme menu | `[data-open=recordings]`, `[data-open=launch]`, `[data-open=theme]` |
| A recording in the list | `[data-recording="<file>.jsonl"]` (newest first) |
| Category toggle | `[title^="<category>:"]` — title reads e.g. `system: hidden. Click to show it.` |
| Search box / match count / next-prev | `[aria-label="Search the conversation"]`, `[data-tally]`, `[data-step]` |
| Step strip / step back, forward | `[aria-label="Steps"]`, `[title="The step before (←)"]`, `[title="The step after (→)"]` |
| Launch form | `[data-launch-session]`, `[data-launch-command]`, `[data-launch]` |

### Proxy only, beside a stack that holds the ports

```bash
mkdir -p /tmp/ccd-iso/rec
tmux new-session -d -s ccd-iso -n fake "node .claude/skills/run-cc-dump/fake-anthropic.mjs 3398 > /tmp/ccd-iso/fake.log 2>&1"
tmux new-window -t ccd-iso -n proxy "node packages/proxy/src/isolated.ts http://127.0.0.1:3398 /tmp/ccd-iso/rec "$(date -u +%FT%TZ)" 3390 3391 > /tmp/ccd-iso/proxy.log 2>&1"
until curl -sf -o /dev/null http://127.0.0.1:3391/info; do sleep 0.2; done
CC_DUMP_READER_PORT=3391 node .claude/skills/run-cc-dump/traffic.mjs 2
ls /tmp/ccd-iso/rec
tmux kill-session -t ccd-iso
```

Runs this worktree's proxy source on spare ports, with its fake on 3398 so a `stack.sh` fake on 3399 is left alone;
each line is its own command, so the steps may be separate calls. The third argument is the run's start, which names
its recording.
`isolated.ts` is also what the proxy's tests run. A real Claude Code works against it too, for free:

```bash
curl -s -X POST http://127.0.0.1:3391/recordings          # -> {"name":"<stem>.jsonl"}
ANTHROPIC_BASE_URL=http://127.0.0.1:3390/agent/<stem> ANTHROPIC_API_KEY=fake claude -p "say hi"
```

## Run (human path)

`pnpm dev`, open http://127.0.0.1:3346. It uses `~/.config/cc-dump` and `~/.local/share/cc-dump/recordings` and
forwards to the real Anthropic API.

## Test

```bash
pnpm test        # vitest, ~2s; binds port 0, so it runs fine beside a live stack
```

## Gotchas

- `click text=agent` hits "Launch **an agent**, or open a recording." before the list item — `text=` is a substring
  match. Use the `data-*` selectors above.
- `wait [aria-label="Steps"]` resolves before the recording has been read; `text` then says `0 / 0`. Wait on
  `[aria-current=step]`.
- Agent traffic is attributed by URL path (`/agent/<stem>`), never by header; a request without it goes to the run's
  `run-<time>.jsonl`. `x-api-key`/`authorization` are never written to a recording.
- The one console error on every page, `404 (Not Found)`, is `/favicon.ico`. Ignore it.
- Opening a recording is read-only; the recordings list is every `.jsonl` in the directory, so a copied-in file shows up
  (marked "Recording ended", since no writer holds it).

## Troubleshooting

- `stack.sh up` prints holders and exits 1 → another stack (its cwd is printed) or a leftover fake on 3399 is running.
  A cwd in this worktree is yours: `stack.sh down`.
- `playwright-core not found under ~/.cache/run-cc-dump` → run the Prerequisites install.
