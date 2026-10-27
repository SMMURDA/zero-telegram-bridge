---
description: Restart the running Zero Telegram bridge (after a plugin update)
---

Restart the installed Zero Telegram bridge without asking for a token.

Locate the installed plugin's restart script:

```sh
RESTART=$(find "$HOME/.zero/plugins" -type f -path '*/zero-telegram-bridge/*/scripts/restart.sh' -print -quit 2>/dev/null)
printf '%s\n' "$RESTART"
```

If it is empty, ask the user to reinstall the plugin. Otherwise run it with
`sh "$RESTART"` and report whether the bridge started.
