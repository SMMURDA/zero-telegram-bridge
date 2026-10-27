#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="${ZERO_BRIDGE_RUNTIME:-$ROOT/runtime}"

if [ ! -f "$RUNTIME/bridge.pid" ]; then
  echo "not running (no bridge.pid)"
  exit 0
fi

pid=$(cat "$RUNTIME/bridge.pid")
kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
sleep 1
kill -KILL "-$pid" 2>/dev/null
rm -f "$RUNTIME/bridge.pid"
echo "stopped (pid $pid)"
