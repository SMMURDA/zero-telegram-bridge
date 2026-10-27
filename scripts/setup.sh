#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DATA="${ZERO_BRIDGE_HOME:-${HOME}/.zero/telegram-bridge}"
CONFIG="${ZERO_BRIDGE_CONFIG:-$DATA/config.json}"
TOKEN="${1:-${TELEGRAM_BOT_TOKEN:-}}"
CHAT_ID="${2:-${TELEGRAM_CHAT_ID:-}}"
DRY_RUN="${TELEGRAM_SETUP_DRY_RUN:-0}"

if [ -z "$TOKEN" ]; then
  printf 'Bot token: ' >&2
  IFS= read -r TOKEN
fi
if [ -z "$TOKEN" ]; then
  echo "Bot token is required." >&2
  exit 1
fi

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

ZERO_BIN_PATH="${ZERO_BIN:-$(command -v zero 2>/dev/null || printf 'zero')}"

TOKEN="$TOKEN" CHAT_ID="$CHAT_ID" CONFIG_PATH="$CONFIG" DRY_RUN="$DRY_RUN" \
  ZERO_BIN="$ZERO_BIN_PATH" \
  "$RUNTIME_BIN" "$ROOT/scripts/setup-telegram.js" || exit 1

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: config written to $CONFIG" >&2
  exit 0
fi

if ! ZERO_BRIDGE_RUNTIME="$DATA" "$ROOT/scripts/start.sh"; then
  echo "Config saved, but the bridge failed to start. See $DATA/bridge.log" >&2
  exit 1
fi

sleep 2
if tail -20 "$DATA/bridge.log" 2>/dev/null | grep -q '409 Conflict'; then
  echo "⚠️ Another bridge is already polling this bot token (409 Conflict)." >&2
  echo "Stop the other bridge before using this one." >&2
fi

echo "Runtime data: $DATA"
echo "Open your bot in Telegram and send /start."
