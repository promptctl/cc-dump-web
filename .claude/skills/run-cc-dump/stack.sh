#!/bin/sh
# Starts and stops this worktree's cc-dump in a tmux session named for the worktree, forwarding to fake-anthropic.mjs,
# with its settings, recordings and logs in a scratch directory instead of ~/.config and ~/.local/share:
#   stack.sh up       the whole stack, as `pnpm dev` runs it: proxy 3344, server 3345, UI 3346, reader 3347; fake on 3399
#   stack.sh proxy    the proxy alone (packages/proxy/src/isolated.ts), beside a stack that holds those ports:
#                     proxy 3390, reader 3391; fake on 3398
#   stack.sh status   who holds each of those ports
#   stack.sh logs     the last lines of each window's log
#   stack.sh down     kill this worktree's session; another worktree's is never touched
# Env: CC_DUMP_HOME, the scratch directory (default /tmp/cc-dump-run).
set -eu
skill=$(cd "$(dirname "$0")" && pwd)
unit=$(cd "$skill/../../.." && pwd)
# Absolute, because the XDG variables it becomes are ignored when relative (packages/config/src/xdg.ts), and the stack
# would then use the real settings, recordings and upstream.
home=${CC_DUMP_HOME:-/tmp/cc-dump-run}
case $home in /*) ;; *) home=$PWD/$home ;; esac
# tmux reads "." and ":" in a target as window and pane separators, and worktrees are named for tickets like a.b.
session=run-cc-dump-$(basename "$unit" | tr .: __)

holders() {
  for port in "$@"; do
    pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN | head -1)
    if [ -n "$pid" ]; then
      echo "$port held by pid $pid, cwd $(lsof -a -p "$pid" -d cwd -Fn | sed -n 's/^n//p')"
    else
      echo "$port free"
    fi
  done
}

refuse_held() {
  if holders "$@" | grep -q held; then
    holders "$@"
    echo "A port is held: another cc-dump (or fake upstream) is running. Drive that one, or, if the cwd above is this worktree, stack.sh down." >&2
    exit 1
  fi
}

logs() {
  tail -n "$1" "$home"/*.log
}

# Each window runs in the worktree under the caller's PATH (not the tmux server's), its output in $SCRATCH/<name>.log.
# Paths reach its command as environment, never spliced into the command's text.
window() {
  name=$1 command=$2
  shift 2
  set -- -n "$name" -c "$unit" -e PATH="$PATH" -e SKILL="$skill" -e SCRATCH="$home" "$@" "$command > \"\$SCRATCH/$name.log\" 2>&1"
  if [ "$name" = fake ]; then tmux new-session -d -s "$session" "$@"; else tmux new-window -t "$session" "$@"; fi
}

answering() {
  for url in "$@"; do curl -sf -m 2 -o /dev/null "$url" || return 1; done
}

ready() {
  for _ in $(seq 60); do
    if answering "$@"; then
      echo "up: session $session, logs $home/*.log"
      return
    fi
    sleep 1
  done
  echo "not up after 60s; its logs, then session $session killed:" >&2
  logs 30 >&2
  tmux kill-session -t "$session"
  exit 1
}

up() {
  refuse_held 3344 3345 3346 3347 3399
  mkdir -p "$home/config/cc-dump" "$home/data"
  echo '{ "upstream": "http://127.0.0.1:3399" }' > "$home/config/cc-dump/proxy.json"
  window fake 'node "$SKILL/fake-anthropic.mjs" 3399'
  window dev 'pnpm dev' -e XDG_CONFIG_HOME="$home/config" -e XDG_DATA_HOME="$home/data"
  ready http://127.0.0.1:3346/ http://127.0.0.1:3347/recordings http://127.0.0.1:3345/launch
  echo "UI http://127.0.0.1:3346  proxy http://127.0.0.1:3344  recordings $home/data/cc-dump/recordings"
}

proxy() {
  refuse_held 3390 3391 3398
  mkdir -p "$home/proxy-recordings"
  window fake 'node "$SKILL/fake-anthropic.mjs" 3398'
  window proxy "node packages/proxy/src/isolated.ts http://127.0.0.1:3398 \"\$SCRATCH/proxy-recordings\" $(date -u +%Y-%m-%dT%H:%M:%SZ) 3390 3391"
  ready http://127.0.0.1:3391/info
  echo "proxy http://127.0.0.1:3390  reader http://127.0.0.1:3391  recordings $home/proxy-recordings"
}

case "${1:-}" in
  up) up ;;
  proxy) proxy ;;
  status) holders 3344 3345 3346 3347 3399 3390 3391 3398 ;;
  logs) logs 60 ;;
  down) tmux kill-session -t "$session" && echo "down: $session" ;;
  *) echo "usage: $0 up|proxy|status|logs|down" >&2; exit 2 ;;
esac
