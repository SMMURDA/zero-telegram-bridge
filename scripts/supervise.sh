#!/bin/sh
set -u

# Supervisor: restart the bridge if it exits.
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="${ZERO_BRIDGE_RUNTIME:-$ROOT/runtime}"
mkdir -p "$RUNTIME"
chmod 700 "$RUNTIME" 2>/dev/null || true

RUNTIME_BIN="${ZERO_BRIDGE_NODE:-}"
if [ -z "$RUNTIME_BIN" ] && command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$major" in
    ''|*[!0-9]*) major=0 ;;
  esac
  if [ "$major" -ge 20 ]; then
    RUNTIME_BIN=node
  fi
fi
if [ -z "$RUNTIME_BIN" ] && command -v bun >/dev/null 2>&1; then
  RUNTIME_BIN=bun
fi
if [ -z "$RUNTIME_BIN" ]; then
  echo "$(date -Is) [supervisor] node or bun is required" >> "$RUNTIME/bridge.log"
  exit 1
fi

ZERO_BRIDGE_NODE="$RUNTIME_BIN"
export ZERO_BRIDGE_NODE
export ZERO_BRIDGE_RUNTIME="$RUNTIME"

cd "$ROOT" || exit 1
echo $$ > "$RUNTIME/bridge.pid"
trap 'rm -f "$RUNTIME/bridge.pid"' EXIT INT TERM

while :; do
  "$RUNTIME_BIN" "$ROOT/src/bridge.js" >> "$RUNTIME/bridge.log" 2>&1
  code=$?
  echo "$(date -Is) [supervisor] bridge exited ($code), restarting in 3s" >> "$RUNTIME/bridge.log"
  sleep 3
done
