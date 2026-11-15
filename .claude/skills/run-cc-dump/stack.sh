#!/bin/sh
# Starts and stops cc-dump (proxy + server + UI, as `pnpm dev` runs them) in the tmux session `run-cc-dump`, with its
# settings and recordings in a scratch directory instead of ~/.config and ~/.local/share.
#   stack.sh up       start; the proxy forwards to fake-anthropic.mjs on 3399 (CC_DUMP_UPSTREAM=real: to Anthropic)
#   stack.sh status   who holds each of cc-dump's ports
#   stack.sh logs     the last lines of the dev window (proxy, server and UI logs, interleaved)
#   stack.sh down     kill the session
# Env: CC_DUMP_HOME, the scratch directory (default /tmp/cc-dump-run).
set -eu
skill=$(cd "$(dirname "$0")" && pwd)
unit=$(cd "$skill/../../.." && pwd)
home=${CC_DUMP_HOME:-/tmp/cc-dump-run}
session=run-cc-dump
# proxy, server, UI, reader: constants in packages/*/src/address.ts, not settings. One stack per machine.
ports="3344 3345 3346 3347"

holders() {
  for port in "$@"; do
    pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
    if [ -n "$pid" ]; then
      echo "$port held by pid $pid, cwd $(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')"
    else
      echo "$port free"
    fi
  done
}

up() {
  if holders $ports 3399 | grep -q held; then
    holders $ports 3399
    echo "A port is held: another cc-dump (or fake upstream) is running. Drive that one, or stop it if it is yours (stack.sh down)." >&2
    exit 1
  fi
  mkdir -p "$home/config/cc-dump" "$home/data"
  if [ "${CC_DUMP_UPSTREAM:-fake}" = real ]; then
    rm -f "$home/config/cc-dump/proxy.json"
  else
    echo '{ "upstream": "http://127.0.0.1:3399" }' > "$home/config/cc-dump/proxy.json"
  fi
  tmux new-session -d -s "$session" -n fake "node '$skill/fake-anthropic.mjs' 3399"
  tmux new-window -t "$session" -n dev "cd '$unit' && XDG_CONFIG_HOME='$home/config' XDG_DATA_HOME='$home/data' pnpm dev"
  for _ in $(seq 60); do
    if curl -sf -o /dev/null http://127.0.0.1:3346/ && curl -sf -o /dev/null http://127.0.0.1:3347/recordings && curl -sf -o /dev/null http://127.0.0.1:3345/launch; then
      echo "up: UI http://127.0.0.1:3346  proxy http://127.0.0.1:3344  recordings $home/data/cc-dump/recordings"
      return
    fi
    sleep 1
  done
  echo "not up after 60s; the dev window says:" >&2
  tmux capture-pane -p -t "$session:dev" | tail -30 >&2
  exit 1
}

case "${1:-}" in
  up) up ;;
  status) holders $ports 3399 ;;
  logs) tmux capture-pane -p -S -200 -t "$session:dev" | tail -60 ;;
  down) tmux kill-session -t "$session" 2>/dev/null && echo down || echo "no session $session" ;;
  *) echo "usage: $0 up|status|logs|down" >&2; exit 2 ;;
esac
