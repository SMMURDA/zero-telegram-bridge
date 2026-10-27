---
description: Set up the Zero Telegram bridge (bot token and chat ID)
argument-hint: "[bot token] [chat id]"
---

Use the `telegram-bridge` skill to set up the bridge for this user.

The user may have provided a bot token and chat ID as arguments. If not, ask
for the bot token from @BotFather. Only ask for the chat ID if automatic
detection fails.

Never echo the token. Follow the skill's setup and troubleshooting steps, then
tell the user to send `/start` to the bot in Telegram.
