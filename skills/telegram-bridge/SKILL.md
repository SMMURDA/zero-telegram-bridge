---
name: telegram-bridge
description: Set up and run the Zero Telegram bridge. Use when the user wants to connect Zero CLI to Telegram, configure a bot token or chat ID, or troubleshoot the bridge.
---

# Zero Telegram Bridge setup

This skill connects the Zero CLI agent to Telegram. The bridge runs as a small
background process and keeps itself alive through a `SessionStart` plugin hook.

## What you need

- A Telegram bot token from [@BotFather](https://t.me/BotFather).
- The user's chat ID. It can be detected automatically after the user sends a
  message to the bot. Otherwise ask for it.
- Node.js 20+ or Bun. The scripts pick whichever is available.

## Setup steps

1. Ask for the bot token. Ask for the chat ID only if auto-detection fails.
   Never repeat the token in your reply or logs.
2. Locate the installed plugin's setup script:

   ```sh
   SETUP=$(find "$HOME/.zero/plugins" -type f -name setup.sh -path '*telegram*/scripts/setup.sh' -print -quit 2>/dev/null)
   printf '%s\n' "$SETUP"
   ```

   If it is empty, ask the user to reinstall the plugin.
3. Run the setup script with the token (and chat ID when known):

   ```sh
   TELEGRAM_BOT_TOKEN='<token>' TELEGRAM_CHAT_ID='<chat id>' sh "$SETUP"
   ```

   Omit `TELEGRAM_CHAT_ID` when the user does not know it. The script validates
   the token, detects the most recent chat after the user messages the bot, sends
   a confirmation message, writes the config, and starts the bridge.
4. Report the bot username and chat ID returned by the script, and tell the user
   to open the bot in Telegram and send `/start`.
5. Runtime data lives in `~/.zero/telegram-bridge`, outside the plugin directory,
   so plugin updates do not erase the token. The plugin's `SessionStart` hook
   starts the bridge on future Zero launches when that config exists.

## Troubleshooting

- **No chat found** — the user must open the bot and send any message first, then
  rerun the setup with the token. Alternatively pass the chat ID explicitly.
- **409 Conflict** — another bridge process is polling the same bot token. Stop
  the old process before starting this one.
- **Node/Bun missing** — install Node.js 20+ or Bun.
- **Bridge fails to start** — inspect `~/.zero/telegram-bridge/bridge.log`.
- **After a plugin update** — run `/telegram-restart` (or rerun
  `/telegram-setup`) so the daemon loads the new code. Runtime data is kept.
