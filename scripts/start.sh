#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/runtime"
mkdir -p "$RUNTIME"

cd "$ROOT" || exit 1

if [ -f "$RUNTIME/bridge.pid" ] && kill -0 "$(cat "$RUNTIME/bridge.pid")" 2>/dev/null; then
  echo "already running (pid $(cat "$RUNTIME/bridge.pid"))"
  exit 0
fi

rm -f "$RUNTIME/bridge.pid"
setsid nohup sh "$ROOT/scripts/supervise.sh" >> "$RUNTIME/bridge.log" 2>&1 < /dev/null &
sleep 1

if [ -f "$RUNTIME/bridge.pid" ] && kill -0 "$(cat "$RUNTIME/bridge.pid")" 2>/dev/null; then
  echo "started (pid $(cat "$RUNTIME/bridge.pid"))"
else
  echo "failed to start; last log lines:"
  tail -20 "$RUNTIME/bridge.log" 2>/dev/null
  exit 1
fi
