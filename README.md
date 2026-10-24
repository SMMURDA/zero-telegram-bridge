# Zero Telegram Bridge

Chat with your [Zero CLI](https://github.com/paean-ai/zero-cli) agent from Telegram. Two-way, session-aware, attachment-friendly, and built for a single owner.

```
Telegram message ──▶ long poll ──▶ zero -p ──▶ JSON result ──▶ Telegram reply
```

No npm dependencies. Just Node.js 20+ and an authenticated `zero` binary.

## Features

- 💬 **Two-way chat** — send a message, get the agent's reply, keep the context.
- 🆕 **Session continuity** — `-c` between messages, `/new` to reset, `/resume` to pick an older session.
- ⚡ **One-tap resume** — `/sessions` shows inline buttons; one click activates that session for the next message.
- 🧠 **Per-chat settings** — model, effort, and working directory independent of any terminal session.
- 📎 **Attachments** — photos, documents, voice notes, and videos are downloaded and handed to the agent.
- ↩️ **Reply context** — quoting a Telegram message includes the quoted text in the prompt.
- ⌨️ **Reply keyboard** — Session, Resume, Model, Effort, Folder, Status, Cost, Stop, Help.
- 🐚 **Shell passthrough** — `!ls -la` runs in the working directory.
- 💰 **Cost tracking** — `/cost` reads `total_cost_usd` from Zero's JSON output.
- 🔒 **Owner allowlist** — every update is checked against `allowedChatIds`.
- ♻️ **Supervisor** — `scripts/start.sh` keeps the bridge alive and restarts it on exit.

## Requirements

- Node.js **20 or newer**
- Zero CLI installed and authenticated (`zero -p "hello"` works)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Quick start

### 1. Create a bot

Open [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token.

Send the new bot a message (for example `hi`). To find your chat ID:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

Or message [@userinfobot](https://t.me/userinfobot).

### 2. Configure

```bash
git clone https://github.com/SMMURDA/zero-telegram-bridge.git
cd zero-telegram-bridge

mkdir -p runtime
cp config.example.json runtime/config.json
chmod 600 runtime/config.json
$EDITOR runtime/config.json
```

Minimum config:

```json
{
  "token": "123456789:AA...",
  "allowedChatIds": [123456789],
  "workdir": "/home/you/zero-workspace"
}
```

The `workdir` is where Zero sessions for this bot live. It is created if missing.

Alternatively, skip the file and use environment variables:

```bash
export TELEGRAM_BOT_TOKEN="123456789:AA..."
export TELEGRAM_ALLOWED_CHAT_IDS="123456789"
export TELEGRAM_WORKDIR="/home/you/zero-workspace"
node src/bridge.js
```

### 3. Run

```bash
./scripts/start.sh    # start in the background (supervised)
./scripts/stop.sh     # stop
```

Open the chat, send `/start`, then just talk to the agent.

## Configuration

| Key | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `token` | `TELEGRAM_BOT_TOKEN` | — | BotFather token (required) |
| `allowedChatIds` | `TELEGRAM_ALLOWED_CHAT_IDS` | — | Comma-separated chat IDs (required) |
| `workdir` | `TELEGRAM_WORKDIR` | `~/zero-workspace` | Zero working directory |
| `zeroBin` | `ZERO_BIN` | `zero` | Path to the Zero CLI binary |
| `model` | `ZERO_MODEL` | `flash` | Default model (`flash`, `pro`, `lite`, or a model ID) |
| `effort` | `ZERO_EFFORT` | `low` | Default effort (`low`, `medium`, `high`, `max`) |
| `jobTimeoutMs` | `ZERO_JOB_TIMEOUT_MS` | `1800000` | Per-message timeout (30 min) |
| `maxFileBytes` | `ZERO_MAX_FILE_BYTES` | `20971520` | Attachment size limit (20 MB) |

Environment variables take precedence. If `TELEGRAM_ALLOWED_CHAT_IDS` is set, it replaces the file list.

Runtime files (`config.json`, `state.json`, `bridge.log`, `bridge.pid`) live in `runtime/` and are gitignored.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Welcome message and keyboard |
| `/help` | Full command reference |
| `/menu` | Re-show the reply keyboard |
| `/new` | Start a fresh conversation |
| `/resume` | Session picker with inline buttons |
| `/resume <number\|id>` | Resume a specific session |
| `/sessions` | Recent sessions for the working directory |
| `/status` | Model, effort, folder, queue, cost, uptime |
| `/model [name]` | View or set the model |
| `/effort [level]` | View or set effort |
| `/cwd [path]` | View or set the working directory |
| `/cost` | Session and lifetime cost |
| `/stop` | Kill the running task and clear the queue |
| `/ping` | Liveness check |
| `/id` | Print the current chat ID |
| `/mcp [args]` | Proxy to `zero mcp` |
| `/plugin [args]` | Proxy to `zero plugin` |
| `/agents` | Proxy to `zero agents` |
| `/doctor` | Proxy to `zero doctor` |
| `/version` | Proxy to `zero --version` |
| `/config` | Bridge config with the token redacted |

Unknown slash commands are forwarded to Zero, so skills such as `/commit` keep working.

## Keyboard

```
🆕 New Session   🗂️ Sessions   ⏪ Resume
🧠 Model         ⚙️ Effort     📁 Folder
📊 Status        💰 Cost       ⏹️ Stop
❓ Help
```

## Sessions

Zero stores sessions as `~/.zero/projects/<slug>/<uuid>.jsonl`, where the slug is the working directory with separators replaced by dashes. The bridge lists the 10 most recent files for the current working directory and attaches them as inline buttons.

Tapping a session:

1. Sets it as the resume target (`resumeId`).
2. Clears the buttons.
3. Confirms the active session.

The next message runs `zero -p -r <id>`. After that, normal `-c` continuation takes over.

## How it works

For each message the bridge runs:

```bash
zero -p \
  --output-format json \
  --dangerously-skip-permissions \
  --model <model> \
  --effort <effort> \
  -- "$PROMPT"
```

- `-c` is added when continuing the current conversation.
- `-r <session-id>` is used for an explicit resume.
- The child is spawned **detached**: Zero's sandbox may terminate its own process group on exit, and a non-detached child would take the bridge down with it.
- `getUpdates` uses a 25-second long-poll, below the idle cutoff of common proxies and container network sandboxes.
- Each HTTP request opens a fresh connection (`https` + `agent: false`) so stale keep-alive sockets cannot stall polling.
- Jobs run serially per bridge. `/stop` sends `SIGTERM` to the child's process group, then `SIGKILL` after 5 seconds.

## Running as a service

On a systemd host, `/etc/systemd/system/zero-telegram-bridge.service`:

```ini
[Unit]
Description=Zero Telegram Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=zero
WorkingDirectory=/opt/zero-telegram-bridge
ExecStart=/usr/bin/node src/bridge.js
EnvironmentFile=/etc/zero-telegram-bridge.env
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/zero-telegram-bridge.env` (mode `600`):

```bash
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_ALLOWED_CHAT_IDS=123456789
TELEGRAM_WORKDIR=/home/zero/zero-workspace
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zero-telegram-bridge
```

## Security

This bridge runs Zero with `--dangerously-skip-permissions` (full auto). The agent can read and write files, run shell commands, install packages, and reach the network without asking.

- Keep `runtime/config.json` at mode `600` and never commit it.
- Treat the bot token like a password. Revoke it with BotFather if it leaks.
- Only chat IDs in `allowedChatIds` are served; everyone else gets a denial.
- A compromised Telegram account or bot token means command execution as the bridge user. Run it in a dedicated user account, container, or VM if that matters.
- The bridge does not sandbox Zero beyond Zero's own tooling.

## Troubleshooting

**`409 Conflict`** — another process is polling the same bot token. Stop the old poller (a previous bridge, an MCP Telegram server, or a second copy).

**Repeated `ETIMEDOUT` on `getUpdates`** — the network path drops idle connections. The bridge polls for 25 seconds per request and opens a fresh socket each time; keep those values unless you know your proxy tolerates longer polls.

**Zero errors** — test the same command manually:

```bash
cd <workdir>
zero -p --output-format json "reply with OK"
```

**The bot does not reply** — check `runtime/bridge.log`. A healthy instance logs `bridge started`, `bot commands synced`, and `polling OK`.

## License

MIT. See [LICENSE](LICENSE).
