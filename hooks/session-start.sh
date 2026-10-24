#!/bin/sh
set -u

# Zero CLI SessionStart hook: make sure the bridge is running.
# start.sh is idempotent, so this is safe on every launch, resume, and
# every nested `zero -p` invocation triggered by the bridge itself.

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME="$ROOT/runtime"
PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"

mkdir -p "$RUNTIME" 2>/dev/null || true

{
  echo "$(date -Is) [hook] SessionStart"
  "$ROOT/scripts/start.sh"
} >> "$RUNTIME/bridge.log" 2>&1 || true

# SessionStart hooks cannot block the session, but exit cleanly anyway.
exit 0
