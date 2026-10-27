#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="${ZERO_BRIDGE_RUNTIME:-$ROOT/runtime}"
mkdir -p "$RUNTIME"
chmod 700 "$RUNTIME" 2>/dev/null || true

pick_runtime() {
  if [ -n "${ZERO_BRIDGE_NODE:-}" ]; then
    printf '%s\n' "$ZERO_BRIDGE_NODE"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    case "$major" in
      ''|*[!0-9]*) major=0 ;;
    esac
    if [ "$major" -ge 20 ]; then
      printf '%s\n' node
      return 0
    fi
  fi

  if command -v bun >/dev/null 2>&1; then
    printf '%s\n' bun
    return 0
  fi

  return 1
}

RUNTIME_BIN=$(pick_runtime) || {
  echo "Node.js 20+ or Bun is required." >&2
  exit 1
}
ZERO_BRIDGE_NODE="$RUNTIME_BIN"
export ZERO_BRIDGE_NODE
export ZERO_BRIDGE_RUNTIME="$RUNTIME"

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
