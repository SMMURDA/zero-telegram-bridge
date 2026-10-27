#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DATA="${ZERO_BRIDGE_HOME:-${HOME}/.zero/telegram-bridge}"
CONFIG="${ZERO_BRIDGE_CONFIG:-$DATA/config.json}"

if [ ! -f "$CONFIG" ]; then
  echo "No config found at $CONFIG. Run /telegram-setup first." >&2
  exit 1
fi

ZERO_BRIDGE_RUNTIME="$DATA" "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
exec env ZERO_BRIDGE_RUNTIME="$DATA" "$ROOT/scripts/start.sh"
