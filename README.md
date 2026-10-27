# Zero Telegram Bridge

[![Version](https://img.shields.io/badge/version-0.13.0-blue)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Chat with your [Zero CLI](https://www.npmjs.com/package/@paean-ai/zero-cli) agent from Telegram. Two-way, session-aware, attachment-friendly, and built for a single owner.

```
Telegram message ──▶ long poll ──▶ zero -p ──▶ JSON result ──▶ Telegram reply
```

No npm dependencies. Just Node.js 20+ (or Bun) and an authenticated `zero` binary.

## Install as a Zero plugin (recommended)

Zero CLI users can install the bridge as a plugin and skip the manual clone:

```bash
zero plugin marketplace add SMMURDA/zero-telegram-bridge
zero plugin install zero-telegram-bridge@smmurda-tools
```

Then run this in Zero CLI:

```text
/telegram-setup
```

Enter your [@BotFather](https://t.me/BotFather) token and chat ID. The setup
validates the token, detects the chat automatically when possible, writes
`~/.zero/telegram-bridge/config.json` with mode `600`, starts the bridge, and a
plugin `SessionStart` hook keeps it running on future launches. Plugin updates
do not erase runtime data. Node.js 20+ or Bun is detected automatically.

The manual install below remains available.

## Features

- 📦 **Installable plugin** — marketplace install plus `/telegram-setup`; enter a token and chat ID and the hook keeps the bridge running.
- 💬 **Two-way chat** — send a message, get the agent's reply, keep the context.
- 🆕 **Session continuity** — `-c` between messages, `/new` to reset, `/resume` to pick an older session.
- 🖥️ **All projects** — terminal sessions and Telegram sessions appear in the same picker; resuming switches to the session's project directory.
- ⚠️ **Active-session guard** — warns before resuming a session that is currently open in a terminal; other sessions in the same project do not trigger it.
- 🗜️ **Compaction** — manual `/compact [instructions]`, plus per-chat auto-compact with a confirmation UI and configurable threshold.
- ⏹️ **ESC-like stop** — `/stop` sends `SIGINT` first, then escalates, so you can give the agent a new direction immediately.
- ⚡ **One-tap resume** — `/sessions` shows inline buttons; one click activates that session for the next message.
- 📄 **Paged sessions** — `/sessions` and `/resume` paginate ten sessions per page across the 60 most recent projects.
- 📋 **Queue control** — `/queue` lists waiting jobs and lets you remove one or clear all; new messages report their queue position.
- 💭 **`/btw`** — ask a side question against the current context in a read-only run; the chat's session, resume state, and context counters stay untouched.
- 🧩 **Skill discovery** — `/skills [query]` lists project, user, and plugin skills with descriptions; the reply keyboard has a **🧩 Skills** button.
- 📤 **File output** — the agent ends its reply with a `[[send-file:/path]]` block to send files and screenshots back.
- 🧠 **Per-chat settings** — model, effort, and working directory independent of any terminal session.
- 🎛️ **Inline settings menus** — one-tap pickers for model, effort, folder, progress, and auto-compact; no commands required.
- 📡 **Live progress** — choose how thinking, tool actions, and answer steps are shown. Tools always stream in one edited message; thinking and answers can be separate messages or join the stream.
- ✨ **Markdown rendering** — bold, italic, code blocks, links, headings, and quotes render properly in Telegram instead of showing literal markers.
- 📎 **Attachments** — photos, documents, voice notes, and videos are downloaded and handed to the agent.
- ↩️ **Reply context** — quoting a Telegram message includes the quoted text in the prompt.
- ⌨️ **Reply keyboard** — Session, Resume, Model, Effort, Folder, Status, Stop, Queue, BTW, Skills, Compact & Auto, Settings, Help.
- 🐚 **Shell passthrough** — `!ls -la` runs in the working directory.
- 💰 **Cost tracking** — `/cost` reads `total_cost_usd` from Zero's JSON output.
- 🔒 **Owner allowlist** — every update is checked against `allowedChatIds`.
- ♻️ **Supervisor** — `scripts/start.sh` keeps the bridge alive and restarts it on exit.
- 🔁 **Auto-start** — optional Zero CLI `SessionStart` hook starts the bridge on every launch or resume.

## Requirements

- Node.js **20 or newer**, or **Bun**
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

### 4. Auto-start with the manual install

Plugin installs get auto-start from the plugin's own `SessionStart` hook. For a
manual clone, add this user-level hook. Zero runs it on every new session,
resume, clear, and compact:

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
| `progressMode` | `ZERO_BRIDGE_PROGRESS_MODE` | `full` | Progress display: `full`, `messages`, `stream`, or `off` |
| `thinkingLanguage` | `ZERO_THINKING_LANGUAGE` | `auto` | Language for thinking blocks: `auto`, `id`, `en`, or a language name |

Environment variables take precedence. If `TELEGRAM_ALLOWED_CHAT_IDS` is set, it replaces the file list.

Runtime files (`config.json`, `state.json`, `bridge.log`, `bridge.pid`) live in
`runtime/` for standalone installs, or in `~/.zero/telegram-bridge` for the
plugin. They are never committed.

## Commands

| Command | Description |
| --- | --- |
| `/start` | Welcome message and keyboard |
| `/help` | Full command reference |
| `/menu` | Re-show the reply keyboard |
| `/new` | Start a fresh conversation |
| `/resume` | Session picker with inline buttons |
| `/resume <number\|id>` | Resume a specific session |
| `/sessions` | Paged picker of recent sessions across all projects |
| `/compact [instructions]` | Summarize the conversation and free context |
| `/compactmenu` | Combined Compact & Auto-compact menu (the keyboard button) |
| `/autocompact` | Auto-compact status; enable/disable with inline confirmation |
| `/progress` | Progress display: `full`, `messages`, `stream`, or `off` |
| `/status` | Model, effort, folder, queue, cost, context, uptime |
| `/queue` | List waiting jobs, remove one, or clear the queue |
| `/btw <question>` | Side question in a read-only run against the current session |
| `/skills [query]` | List project, user, and plugin skills; optional filter |
| `/settings` | Inline menu for model, effort, folder, progress, and auto-compact |
| `/model [name]` | Inline model picker, or set a model directly |
| `/effort [level]` | Inline effort picker, or set effort directly |
| `/cwd [path]` | Inline recent-folder picker, or set the working directory |
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
📊 Status        ⚙️ Settings   ⏹️ Stop
📋 Queue (N)     💭 BTW         🧩 Skills
🗜️ Compact & Auto              ❓ Help
```

**Queue** opens the queue panel. Its label shows the number of active plus
waiting jobs. Telegram reply keyboards cannot be edited in place, so the label
refreshes on the next outgoing message; the activity message is updated live
instead, including an inline **📋 Queue (N)** button. **BTW** opens the usage
hint for `/btw`; **Skills** opens `/skills`.

**Compact & Auto** opens one menu for manual compaction and the auto-compact
settings. **Cost** was removed from the keyboard because `/status` already shows
it; `/cost` remains available as a command.

Tapping **Model**, **Effort**, **Folder**, or **Settings** opens an inline
keyboard. The Settings hub also exposes progress mode and auto-compact, so every
setting is reachable without typing a command. The model picker combines Zero's
built-in tier aliases (`pro`, `flash`, `lite`) with the provider models Zero has
cached in `~/.zero/config.json`; `/model <provider-id>` still accepts any model
ID directly.

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

Zero stores sessions as `~/.zero/projects/<slug>/<uuid>.jsonl`. The bridge scans **every** project directory, so sessions created in a terminal appear in the same picker as Telegram sessions. The picker shows ten sessions per page, newest first, across up to the 60 most recent sessions in every project. Use **Newer** / **Older** to page through them.

Titles come from the first real user turn. The bridge's thinking-language hint is appended after the message and stripped when older session files are read, so sessions no longer share the same `[ATURAN WAJIB: …]` title.

Tapping a session:

1. Sets it as the resume target (`resumeId`).
2. Switches the bot's working directory to the cwd recorded in that session.
3. Clears the buttons and confirms the active session.

The cwd switch is required: `zero -p -r <id>` only finds a session inside its own project directory. After the resumed message, normal `-c` continuation takes over in that project.

If the **same session** is open in an interactive Zero CLI, `/resume` warns first and requires an inline **Resume anyway** / **Cancel** confirmation (valid for 5 minutes). The guard reads Zero's `~/.zero/sessions/<pid>.json` registry for an exact session-ID match and verifies the PID is a live interactive CLI, so the bot's own `-p` jobs and other sessions in the same project do not trigger it. Resuming anyway is possible, but both processes may write the same session and the bot agent will see the terminal context. Avoid using the same session from a terminal and the bot at the same time.

Process verification uses `/proc` on Linux; on other platforms the registry entry is trusted.

`/status` reports context for the bot's own session. After `/resume`, it reads the session's last usage entry and labels the value `last known from session` until the next bot turn updates it. `/new` and `/cwd` reset the context display for the fresh session.

## Skills

`/skills [query]` discovers skills from:

- `<cwd>/.zero/skills/<name>/SKILL.md` — project
- `~/.zero/skills/<name>/SKILL.md` — user
- installed plugin directories under `~/.zero/plugins` — plugin

The name and description come from YAML frontmatter; the folder name is the fallback when no name is set, and the first paragraph is the description fallback. Duplicate names prefer project over user over plugin. Descriptions are cleaned, whitespace-collapsed, and truncated, and results can be filtered with a query. Run a skill with `/<name> [args]`.

Built-in Zero skills bundled inside the CLI are not enumerable from `-p` mode, so they are not listed by `/skills`; they still work by name.

## Queue and side questions

Messages that arrive while a job is running are queued and run in order. The bot replies with the queue position. `/queue` shows the running job and the first ten waiting jobs; each waiting job has a remove button, plus a button to clear the queue. The queue is capped at 50 jobs.

`/btw <question>` asks a side question without starting a new turn in the chat. It resumes the current session with `--no-session-persistence`, so it can read the conversation context but cannot write to it or create a new session file. The answer arrives as a separate `💭 BTW` message. BTW spend is added to the bridge total, but the chat's session cost pointer, context counters, and resume state are unchanged. `/stop` also cancels a running BTW question.

## File output

The agent can send files back to Telegram. It ends its final reply with a contiguous marker block, one file per line:

```
[[send-file:/absolute/path/report.pdf]]
```

Relative paths resolve from the current working directory. Only a trailing block of marker lines is consumed; markers inside a sentence, a code span, or followed by more text are ignored, so quoted examples do not trigger uploads. Images up to 10 MB try `sendPhoto` and automatically fall back to `sendDocument` if Telegram rejects the image (for example, `IMAGE_PROCESS_FAILED`); other files use `sendDocument`. The size limit is `maxFileBytes` (20 MB by default). The bridge refuses to send its own config, state, log, or `.git-credentials`.

## Progress modes

Use `/progress` to switch how work is shown:

- **full** (default) — thinking and all tool actions share one activity message; answer steps are separate:

  ```
  💬
  I'll check the files first.

  🧠 Working… 18s

  [3s] 🤔 Thinking
  > **Plan**
  > • list the files
  > • read the bridge

  [7s] 🔧 Bash
  > ls -la

  [11s] 📖 Read
  > src/bridge.js
  ```

- **messages** — tool actions share one activity message; thinking and answer steps are separate:

  ```
  🤔 Thinking
  > **Plan**
  > • list the files
  > • read the bridge

  💬
  I'll check the files first.

  🧠 Working… 18s

  [7s] 🔧 Bash
  > ls -la

  [11s] 📖 Read
  > src/bridge.js
  ```

- **stream** — only tool actions stream in one activity message; thinking is hidden; answer steps are separate:

  ```
  💬
  I'll check the files first.

  🧠 Working… 18s

  [7s] 🔧 Bash
  > ls -la

  [11s] 📖 Read
  > src/bridge.js
  ```

- **off** — only the final answer.

All modes except `off` send answer steps in order with a small throttle (~3 per second) and always send the final answer last. In `full`, thinking is rendered as a quote block with its line structure and common Markdown preserved, capped at 12 lines / ~900 characters. The activity message keeps the latest 14 entries (thinking or tools) and trims the oldest entry as a whole, never a partial line. It finalizes the header with `✅ Done`, `⏹️ Stopped`, `⏱️ Timed out`, or `❌ Failed`. Recognized activities: Bash, Read, Edit/MultiEdit/Write, Grep/Glob, WebFetch/WebSearch, Agent/Task, plus a generic fallback; tool detail is shown in monospace.

When `thinkingLanguage` is set (for example `"id"`), the bridge appends a system instruction asking the model to write its thinking blocks in that language. The final answer still follows the language of the request. Set it to `"auto"` to leave thinking language to the model.

## Formatting

Agent replies are converted from Markdown to Telegram HTML before sending:

- Bold, italic, bold+italic, and strikethrough
- Inline code and fenced code blocks (HTML inside code is escaped)
- Links, headings, blockquotes, bullet lists, and horizontal rules

If Telegram rejects the entities, the bridge falls back to sending the raw text so the answer is never lost. The converter lives in `src/markdown.js` and is covered by `npm test` (also run in CI).

Interactive CLI tools such as `AskUserQuestion` are disabled for bridge jobs (`--disallowedTools AskUserQuestion`), and a system instruction tells the agent to ask clarifying questions as plain text. Answer the question with your next message.

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

## License

MIT. See [LICENSE](LICENSE).
