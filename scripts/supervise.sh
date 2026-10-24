#!/bin/sh
set -u

# Supervisor: restart the bridge if it exits.
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/runtime"
mkdir -p "$RUNTIME"

cd "$ROOT" || exit 1
echo $$ > "$RUNTIME/bridge.pid"
trap 'rm -f "$RUNTIME/bridge.pid"' EXIT INT TERM

while :; do
  node "$ROOT/src/bridge.js" >> "$RUNTIME/bridge.log" 2>&1
  code=$?
  echo "$(date -Is) [supervisor] bridge exited ($code), restarting in 3s" >> "$RUNTIME/bridge.log"
  sleep 3
done
