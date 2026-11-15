#!/bin/sh
# Starts and stops this worktree's cc-dump (proxy + server + UI, as `pnpm dev` runs them) in a tmux session named for
# the worktree, with its settings and recordings in a scratch directory instead of ~/.config and ~/.local/share, and
# its proxy forwarding to fake-anthropic.mjs on 3399.
#   stack.sh up       start
#   stack.sh status   who holds each of cc-dump's ports
#   stack.sh logs     the last lines of the fake's and the stack's logs (proxy, server and UI, interleaved)
#   stack.sh down     kill this worktree's session; another worktree's is never touched
# Env: CC_DUMP_HOME, the scratch directory (default /tmp/cc-dump-run).
set -eu
skill=$(cd "$(dirname "$0")" && pwd)
unit=$(cd "$skill/../../.." && pwd)
# Absolute, because the XDG variables it becomes are ignored when relative (packages/config/src/xdg.ts), and the stack
# would then use the real settings, recordings and upstream.
home=${CC_DUMP_HOME:-/tmp/cc-dump-run}
case $home in /*) ;; *) home=$PWD/$home ;; esac
session=run-cc-dump-$(basename "$unit")
# server, UI, reader: constants in packages/*/src/address.ts. proxy: the default of proxy.json's `port`, which `up`
# leaves unset. The fake upstream.
ports="3344 3345 3346 3347 3399"

holders() {
  for port in $ports; do
    pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN | head -1)
    if [ -n "$pid" ]; then
      echo "$port held by pid $pid, cwd $(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')"
    else
      echo "$port free"
    fi
  done
}

logs() {
  for log in fake dev; do
    echo "== $home/$log.log"
    tail -"$1" "$home/$log.log"
  done
}

up() {
  if holders | grep -q held; then
    holders
    echo "A port is held: another cc-dump (or fake upstream) is running. Drive that one, or, if the cwd above is this worktree, stack.sh down." >&2
    exit 1
  fi
  mkdir -p "$home/config/cc-dump" "$home/data"
  echo '{ "upstream": "http://127.0.0.1:3399" }' > "$home/config/cc-dump/proxy.json"
  # The caller's PATH, not the tmux server's, picks the node and pnpm the windows run.
  tmux new-session -d -s "$session" -n fake -e PATH="$PATH" "node '$skill/fake-anthropic.mjs' 3399 > '$home/fake.log' 2>&1"
  tmux new-window -t "$session" -n dev -e PATH="$PATH" -e XDG_CONFIG_HOME="$home/config" -e XDG_DATA_HOME="$home/data" \
    "cd '$unit' && pnpm dev > '$home/dev.log' 2>&1"
  for _ in $(seq 60); do
    if curl -sf -o /dev/null http://127.0.0.1:3346/ && curl -sf -o /dev/null http://127.0.0.1:3347/recordings && curl -sf -o /dev/null http://127.0.0.1:3345/launch; then
      echo "up: UI http://127.0.0.1:3346  proxy http://127.0.0.1:3344  recordings $home/data/cc-dump/recordings  session $session"
      return
    fi
    sleep 1
  done
  tmux kill-session -t "$session"
  echo "not up after 60s; session $session killed. Its logs:" >&2
  logs 30 >&2
  exit 1
}

case "${1:-}" in
  up) up ;;
  status) holders ;;
  logs) logs 60 ;;
  down) tmux kill-session -t "$session" && echo "down: $session" ;;
  *) echo "usage: $0 up|status|logs|down" >&2; exit 2 ;;
esac
