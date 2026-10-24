# Zero Telegram Bridge

[![Version](https://img.shields.io/badge/version-0.4.5-blue)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Chat with your [Zero CLI](https://github.com/paean-ai/zero-cli) agent from Telegram. Two-way, session-aware, attachment-friendly, and built for a single owner.

```
Telegram message ──▶ long poll ──▶ zero -p ──▶ JSON result ──▶ Telegram reply
```

No npm dependencies. Just Node.js 20+ and an authenticated `zero` binary.

## Features

- 💬 **Two-way chat** — send a message, get the agent's reply, keep the context.
- 🆕 **Session continuity** — `-c` between messages, `/new` to reset, `/resume` to pick an older session.
- 🖥️ **All projects** — terminal sessions and Telegram sessions appear in the same picker; resuming switches to the session's project directory.
- 🗜️ **Compaction** — manual `/compact [instructions]`, plus per-chat auto-compact with a confirmation UI and configurable threshold.
- ⏹️ **ESC-like stop** — `/stop` sends `SIGINT` first, then escalates, so you can give the agent a new direction immediately.
- ⚡ **One-tap resume** — `/sessions` shows inline buttons; one click activates that session for the next message.
- 🧠 **Per-chat settings** — model, effort, and working directory independent of any terminal session.
- 📡 **Live progress** — one Telegram message updates in place as the agent runs Bash, edits files, reads, searches, and fetches.
- ✨ **Markdown rendering** — bold, italic, code blocks, links, headings, and quotes render properly in Telegram instead of showing literal markers.
- 📎 **Attachments** — photos, documents, voice notes, and videos are downloaded and handed to the agent.
- ↩️ **Reply context** — quoting a Telegram message includes the quoted text in the prompt.
- ⌨️ **Reply keyboard** — Session, Resume, Model, Effort, Folder, Status, Cost, Stop, Help.
- 🐚 **Shell passthrough** — `!ls -la` runs in the working directory.
- 💰 **Cost tracking** — `/cost` reads `total_cost_usd` from Zero's JSON output.
- 🔒 **Owner allowlist** — every update is checked against `allowedChatIds`.
- ♻️ **Supervisor** — `scripts/start.sh` keeps the bridge alive and restarts it on exit.
- 🔁 **Auto-start** — optional Zero CLI `SessionStart` hook starts the bridge on every launch or resume.

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

### 4. Auto-start with Zero CLI (recommended)

If the bridge dies whenever you close your terminal, add a user-level `SessionStart` hook. Zero runs it on every new session, resume, clear, and compact:

`~/.zero/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/zero-telegram-bridge/hooks/session-start.sh </dev/null >/dev/null 2>&1 || true",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The hook calls `scripts/start.sh`, which is idempotent: it checks the PID **and** the process command line, so it is a no-op while the bridge is already running. Hooks are skipped in `--bare` mode and when hooks are disabled.

If your host tears down every process when the CLI exits, the bridge will stop with the CLI; the hook simply starts it again on the next launch. For a bridge that is independent of Zero, run it with systemd instead (see below).

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
| `autoCompact` | `ZERO_BRIDGE_AUTO_COMPACT` | `false` | Default auto-compact state for new chats (`1` enables) |
| `autoCompactThreshold` | `ZERO_BRIDGE_AUTO_COMPACT_THRESHOLD` | `0.75` | Context fraction that triggers auto-compact |

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
| `/compact [instructions]` | Summarize the conversation and free context |
| `/autocompact` | Auto-compact status; enable/disable with inline confirmation |
| `/status` | Model, effort, folder, queue, cost, context, uptime |
| `/model [name]` | View or set the model |
| `/effort [level]` | View or set effort |
| `/cwd [path]` | View or set the working directory |
| `/cost` | Session and lifetime cost |
| `/stop` | Interrupt the running task (SIGINT, then escalate) and clear the queue |
| `/ping` | Liveness check |
| `/id` | Print the current chat ID |
| `/mcp [args]` | Proxy to `zero mcp` |
| `/plugin [args]` | Proxy to `zero plugin` |
| `/agents` | Proxy to `zero agents` |
| `/doctor` | Non-interactive health summary (the full `zero doctor` UI needs a terminal) |
| `/version` | Bridge version and Zero CLI version |
| `/config` | Bridge config with the token redacted |

Unknown slash commands are forwarded to Zero, so skills such as `/commit` keep working.

## Keyboard

```
🆕 New Session   🗂️ Sessions   ⏪ Resume
🧠 Model         ⚙️ Effort     📁 Folder
📊 Status        💰 Cost       ⏹️ Stop
🗜️ Compact       🔄 Auto-Compact   ❓ Help
```

## Compaction

`/compact [instructions]` runs Zero's non-interactive compaction command in the current session:

```bash
zero -p -c --output-format json -- "/compact [instructions]"
```

The session ID stays the same and the summary remains in context.

Auto-compact is **per chat** and off by default:

- Tap **🔄 Auto-Compact** or send `/autocompact`.
- The bot shows the current context usage, the threshold, and inline buttons: **Turn on/off** and **60% / 75% / 85%**.
- The setting changes only after you tap a button — that is the confirmation step.
- After each reply, the bridge checks the latest usage from Zero's JSON output. If context usage is at or above the threshold, it runs `/compact`, then sends a short notice.
- A 5-minute cooldown after each compact (and after failures) prevents retry loops.
- `/autocompact on|off` and `/autocompact threshold 80` are available as direct shortcuts; `/autocompact` without arguments always shows the confirmation UI.

The bridge passes `DISABLE_AUTO_COMPACT=1` to every `zero` child, so Zero's built-in auto-compact cannot bypass the Telegram toggle. Manual `/compact` is unaffected.

## Sessions

Zero stores sessions as `~/.zero/projects/<slug>/<uuid>.jsonl`. The bridge scans **every** project directory, so sessions created in a terminal appear in the same picker as Telegram sessions. The 12 most recent are shown with their project path.

Tapping a session:

1. Sets it as the resume target (`resumeId`).
2. Switches the bot's working directory to the cwd recorded in that session.
3. Clears the buttons and confirms the active session.

The cwd switch is required: `zero -p -r <id>` only finds a session inside its own project directory. After the resumed message, normal `-c` continuation takes over in that project. Avoid using the same session from a terminal and the bot at the same time.

## Live progress

While a job runs, the bridge reads Zero's streaming output and updates **one** Telegram message in place:

```
🧠 Working… 18s

[3s] 🔧 Bash: ls -la
[7s] 📖 Read: src/bridge.js
[11s] ✏️ Edit: src/bridge.js
[16s] 🔧 Bash: node --check src/bridge.js
```

- The message is created lazily on the first tool call, so simple chat replies leave no extra message behind.
- Recognized activities: Bash, Read, Edit/MultiEdit/Write, Grep/Glob, WebFetch/WebSearch, Agent/Task, and a generic fallback for other tools.
- Edits are throttled to roughly one per 1.5 seconds and keep the latest 14 steps.
- When the job ends the header becomes `✅ Done in Xs`, `⏹️ Stopped`, `⏱️ Timed out`, or `❌ Failed`.
- The final answer is sent as a separate message.

## Formatting

Agent replies are converted from Markdown to Telegram HTML before sending:

- Bold, italic, bold+italic, and strikethrough
- Inline code and fenced code blocks (HTML inside code is escaped)
- Links, headings, blockquotes, bullet lists, and horizontal rules

If Telegram rejects the entities, the bridge falls back to sending the raw text so the answer is never lost. The converter lives in `src/markdown.js` and is covered by `npm test` (also run in CI).

### Health check

`/doctor` returns a non-interactive summary of the bridge, Zero CLI, config files, agents, MCP servers, disk space, session state, and recent log issues. The full `zero doctor` command is an interactive Ink UI that requires a TTY, so it is intended for your terminal and is not invoked by the bot.

## How it works

For each normal message the bridge runs:

```bash
zero -p \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  --model <model> \
  --effort <effort> \
  -- "$PROMPT"
```

Compaction jobs use `--output-format json`.

- `-c` is added when continuing the current conversation.
- `-r <session-id>` is used for an explicit resume.
- The child is spawned **detached**: Zero's sandbox may terminate its own process group on exit, and a non-detached child would take the bridge down with it.
- `getUpdates` uses a 25-second long-poll, below the idle cutoff of common proxies and container network sandboxes.
- Each HTTP request opens a fresh connection (`https` + `agent: false`) so stale keep-alive sockets cannot stall polling.
- Jobs run serially per bridge. `/stop` behaves like ESC/Ctrl+C: it sends `SIGINT` to the child's process group, escalates to `SIGTERM` after 2 seconds, then `SIGKILL` after 5 seconds. The queue is cleared and you can send the next message immediately; Zero resumes from the last saved session state.

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

## Versioning

This project follows [Semantic Versioning](https://semver.org/). Every release is tagged `vMAJOR.MINOR.PATCH`, documented in [CHANGELOG.md](CHANGELOG.md), and shipped with a source ZIP asset on the [Releases](https://github.com/SMMURDA/zero-telegram-bridge/releases) page.

The running version is visible in `/status`, `/version`, `/config`, and the startup log/message.

### Releasing

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag:
   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z — short description"
   ```
3. Push the commit and tag:
   ```bash
   git push origin main --tags
   ```

The `Release` GitHub Actions workflow builds `zero-telegram-bridge-vX.Y.Z.zip` from the tagged commit and creates the GitHub release with generated notes.

## License

MIT. See [LICENSE](LICENSE).
