#!/bin/sh
set -u

# Plugin SessionStart hook. Runtime data (config, state, log, pid) lives in a
# stable user directory, so updating the plugin never deletes the bot token.
if [ "${ZERO_BRIDGE_CHILD:-}" = "1" ]; then
  exit 0
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DATA="${ZERO_BRIDGE_HOME:-${HOME}/.zero/telegram-bridge}"
CONFIG="${ZERO_BRIDGE_CONFIG:-$DATA/config.json}"

# Nothing to start until /telegram-setup has written the config.
[ -f "$CONFIG" ] || exit 0

mkdir -p "$DATA" 2>/dev/null || true
chmod 700 "$DATA" 2>/dev/null || true

{
  echo "$(date -Is) [plugin-hook] SessionStart"
  ZERO_BRIDGE_RUNTIME="$DATA" "$ROOT/scripts/start.sh"
} >> "$DATA/bridge.log" 2>&1 || true

exit 0
