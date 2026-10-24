#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/runtime"
mkdir -p "$RUNTIME"

cd "$ROOT" || exit 1

is_running() {
  [ -f "$RUNTIME/bridge.pid" ] || return 1
  pid=$(cat "$RUNTIME/bridge.pid" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
  case "$cmd" in
    *supervise.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

if is_running; then
  echo "already running (pid $(cat "$RUNTIME/bridge.pid"))"
  exit 0
fi

rm -f "$RUNTIME/bridge.pid"
setsid nohup sh "$ROOT/scripts/supervise.sh" >> "$RUNTIME/bridge.log" 2>&1 < /dev/null &
sleep 1

if is_running; then
  echo "started (pid $(cat "$RUNTIME/bridge.pid"))"
else
  echo "failed to start; last log lines:"
  tail -20 "$RUNTIME/bridge.log" 2>/dev/null
  exit 1
fi
