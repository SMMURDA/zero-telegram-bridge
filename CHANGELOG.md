# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

> Releases v0.1.0–v0.4.1 were tagged retroactively from the project's commit
> history.

## [Unreleased]

Nothing yet.

## [0.10.2] - 2026-10-26

### Fixed

- Session titles no longer repeat the thinking-language hint for every Telegram
  session. The hint is appended after the user's message instead of before it,
  so Zero stores the real message as the first user turn and uses it as the
  session title.
- Existing sessions are listed with the hint stripped as well, so `/sessions`
  and `/resume` show readable titles for history created before this release
  without rewriting any session file.
- Unrelated bracketed prefixes such as `[INFO]` are left untouched, so only the
  bridge's own thinking-language hints are removed.

### Changed

- The thinking-language instruction now trails the prompt. Reasoning models
  still receive it in the same user turn, while the beginning of the turn stays
  clean for titles and previews.

## [0.10.1] - 2026-10-24

### Fixed

- The activity message now renders thinking as a compact quote block with
  proper paragraphs, headings, bullets, bold, and inline code instead of one
  flattened, truncated line of raw Markdown.
- Activity messages are edited with Telegram HTML safely; output is escaped and
  falls back to plain text if Telegram rejects an entity.
- Long activity logs trim the oldest whole entries instead of slicing the first
  line mid-word.
- Tool entries show the first command line in monospace, so heredocs and other
  multi-line commands no longer produce broken single-line log entries.
- Separate thinking messages (`messages` mode) are sent as quote blocks with
  escaped HTML, matching the activity-message formatting.

## [0.10.0] - 2026-10-24

### Added

- `/compactmenu` and the combined **🗜️ Compact & Auto** keyboard button: one
  menu for compacting now or opening the auto-compact panel.
- The startup message now refreshes the reply keyboard, so layout changes appear
  without sending `/start` or `/menu`.
- Legacy reply-keyboard labels (`💰 Cost`, `🔄 Auto-Compact`) are still mapped to
  their commands for clients showing an older keyboard.

### Changed

- The reply keyboard now shows **⚙️ Settings** directly and no longer shows
  **💰 Cost**; `/cost` and `/status` still provide cost information.

## [0.9.0] - 2026-10-24

### Added

- `thinkingLanguage` setting to ask the model to write thinking blocks in a
  specific language (`id`, `en`, or a language name). The final answer keeps the
  user's language.

### Changed

- `full` is now the default progress mode: thinking and all tool actions stream
  in one activity message, while answer steps remain separate messages.
- Sessions without an explicit `/progress` choice follow the configured default;
  choosing a mode in the menu or with `/progress` pins it.

## [0.8.0] - 2026-10-24

### Added

- `full` progress mode: thinking and tool actions stream together in one
  activity message, while answer steps remain separate messages.

### Changed

- `/progress` now offers four modes: `full`, `messages`, `stream`, and `off`.
- `stream` now means "tools only stream": thinking is hidden and answer steps
  remain separate messages.
- `messages` remains the default: tools stream; thinking and answer steps are
  separate messages.

## [0.7.1] - 2026-10-24

### Changed

- Thinking is now sent as its own Telegram message (full text, no truncation)
  in both `messages` and `stream` modes.
- Only tool actions are combined into the streamed activity message. Answer
  steps and thinking remain separate messages.

## [0.7.0] - 2026-10-24

### Added

- Thinking blocks from `stream-json` are shown in the activity message
  (`🤔 Thinking: …`, truncated to 700 characters).

### Changed

- `messages` mode no longer sends every tool call as its own Telegram message.
  Answer steps still arrive as separate messages, but thinking and all tool
  actions now share one activity message edited in place.
- `stream` mode also includes thinking blocks; the final answer remains a
  separate message.
- Both streaming modes keep the activity message under Telegram's 4096-character
  limit.

## [0.6.0] - 2026-10-24

### Added

- Inline settings menus: `/model` and `/effort` now open tap-to-select panels
  instead of asking for a command argument.
- `/settings` hub with buttons for model, effort, folder, progress mode, and
  auto-compact.
- `/cwd` opens a picker of the current, home, workspace, and recently used
  session folders.
- The model picker lists Zero's tier aliases plus the provider models cached in
  `~/.zero/config.json`.
- Inline panels include a **⬅️ Settings** button, and keep a checkmark on the
  active value.

### Changed

- The reply keyboard's **🔄 Auto-Compact** button is replaced by **⚙️ Settings**;
  auto-compact is still available from the hub and `/autocompact`.
- **Model**, **Effort**, and **Folder** keyboard buttons now open inline menus.

## [0.5.0] - 2026-10-24

### Added

- `/progress` with three modes: `messages` (default), `stream`, and `off`.
- Messages mode posts assistant text between tool calls and each tool action as
  a separate Telegram message, in order.
- Assistant text extraction from `stream-json`, with per-message deduplication
  and a small send throttle.

### Changed

- The default progress mode is `messages`. `stream` keeps the single edited
  message with tool actions.

## [0.4.9] - 2026-10-24

### Fixed

- `AskUserQuestion` caused an `Answer questions?` error when the agent ran
  through Telegram, because `zero -p` has no interactive UI. Bridge jobs now
  pass `--disallowedTools AskUserQuestion` and a system instruction to ask
  clarifying questions as plain text.

## [0.4.8] - 2026-10-24

### Changed

- The resume guard now matches the exact session ID using Zero's
  `~/.zero/sessions/<pid>.json` registry. A terminal session in the same
  project no longer triggers a warning for a different session.
- The guard verifies the PID is a live interactive Zero CLI before warning,
  excluding the bot's own `-p` children.

### Fixed

- The bot's headless `-p` children register with `kind: "interactive"`; they no
  longer cause false active-session warnings.

## [0.4.7] - 2026-10-24

### Added

- Safety guard before resuming a session whose project has an active
  interactive Zero CLI. The bot shows a warning and requires an inline
  **Resume anyway** / **Cancel** confirmation, valid for 5 minutes.
- `findActiveTerminal` detection based on interactive CLI processes (TTY stdin,
  matching cwd), ignoring the bot's own `-p` children.

### Changed

- `/resume` and the inline session picker share the same guard.
- `/new`, `/cwd`, and cancelling clear the pending confirmation.

## [0.4.6] - 2026-10-24

### Fixed

- `/status` now shows a resumed session's last known context immediately after
  `/resume` instead of the bot's previous-session value. It is read from the
  session file and labeled `last known from session` until the next bot turn.
- `/new` and `/cwd` reset context usage, so a fresh session no longer displays
  the old session's percentage.
- `/status` labels context as `bot session` when it comes from the bot's own
  last completed turn.

### Added

- `readLastUsage` in `src/sessions.js`, with unit tests.

## [0.4.5] - 2026-10-24

### Added

- Session discovery now scans every project under `~/.zero/projects`, so
  sessions created in a terminal appear in `/sessions` and `/resume` alongside
  Telegram sessions.
- Session buttons show the project path and the bridge switches to that
  session's cwd when resuming.
- `findSessionById` for exact lookups without the recent-sessions limit.
- Session discovery unit tests.

### Fixed

- The Telegram picker only showed the bot's own working directory, hiding all
  terminal sessions. This was because the bridge read a single project
  directory and never switched cwd before `zero -p -r`.

## [0.4.4] - 2026-10-24

### Fixed

- `/doctor` no longer runs the interactive Ink UI inside the bot, which failed
  with `Raw mode is not supported on the current process.stdin`. It now returns
  a non-interactive health summary: bridge/Zero/Node versions, config file
  validity, agents, MCP servers, disk space, session state, and recent log
  issues.

### Changed

- The full `zero doctor` command remains terminal-only; the bot documentation
  explains the difference.

## [0.4.3] - 2026-10-24

### Added

- Markdown-to-Telegram-HTML rendering for agent replies: bold, italic,
  bold+italic, strikethrough, inline code, fenced code blocks, links, headings,
  blockquotes, bullet lists, and horizontal rules.
- `src/markdown.js` converter and `test/markdown.test.js` unit tests
  (`npm test`, also run in CI).

### Fixed

- Literal Markdown markers such as `**Halo**` no longer appear in replies;
  Telegram renders them as formatting.
- Formatted messages fall back to plain text if Telegram rejects the entities.

## [0.4.2] - 2026-10-24

### Added

- Automated GitHub release workflow: pushing a `v*` tag builds a source ZIP and
  creates a release with notes from the matching changelog section.

### Changed

- `/stop` now interrupts like ESC/Ctrl+C: `SIGINT` first, then `SIGTERM` after
  2 seconds, then `SIGKILL` after 5 seconds. The queue is cleared and the next
  message can be sent immediately; the bridge resumes from the last saved
  session state.
- The release workflow uses the matching `CHANGELOG.md` section as the GitHub
  release body, appending a compare link to the previous tag. Auto-generated
  notes remain the fallback when no section exists.
- The versioning and release process is documented in the README.

### Fixed

- Stop and timeout escalation timers are cleared when the child exits, so a
  reused PID cannot receive stray signals.

## [0.4.1] - 2026-10-24

### Fixed

- The `SessionStart` hook no longer runs for `zero -p` jobs spawned by the
  bridge itself (`ZERO_BRIDGE_CHILD=1`), removing duplicate start checks and
  log noise.

## [0.4.0] - 2026-10-24

### Added

- Live tool progress in a single Telegram message, updated in place as the
  agent works.
- Recognized activities: Bash, Read, Edit/MultiEdit/Write, Grep/Glob,
  WebFetch/WebSearch, Agent/Task, plus a generic fallback for other tools.
- Final progress states: `✅ Done`, `⏹️ Stopped`, `⏱️ Timed out`, `❌ Failed`.
- Edits are throttled to roughly one per 1.5 seconds and keep the latest 14
  steps; the message is created lazily on the first tool call.

### Changed

- Normal jobs run with `--output-format stream-json --verbose`; compaction
  jobs keep using `--output-format json`.

## [0.3.0] - 2026-10-24

### Added

- `/compact [instructions]` and the `🗜️ Compact` reply-keyboard button.
- Per-chat auto-compact toggle with inline confirmation and 60% / 75% / 85%
  thresholds.
- `/autocompact` status and confirmation UI, plus `on`, `off`, and
  `threshold <percent>` shortcuts.
- Context usage, auto-compact status, and the last compact time in `/status`.
- Five-minute cooldown after compacts and after failures to prevent loops.

### Changed

- Bridge-spawned Zero processes run with `DISABLE_AUTO_COMPACT=1`, so the
  Telegram toggle is authoritative over Zero's built-in auto-compact.

## [0.2.0] - 2026-10-24

### Added

- User-level `SessionStart` hook to start the bridge automatically whenever
  Zero launches or resumes.
- `hooks/session-start.sh` and README instructions for the hook.

### Changed

- `scripts/start.sh` now validates both the PID and the process command line
  before treating the bridge as already running.

## [0.1.0] - 2026-10-24

### Added

- Initial release: two-way Telegram chat for Zero CLI.
- Session continuity with `-c`, `/new`, `/resume`, and `/sessions`, including
  a one-tap inline session picker.
- Per-chat model, effort, and working-directory settings.
- Photo, document, voice, and video attachments; quoted-reply context.
- Persistent reply keyboard, English UI, and 22-command Telegram menu.
- Shell passthrough with `!command`, cost tracking, and an owner allowlist.
- Supervisor scripts, example config, MIT license, and CI syntax checks.

[Unreleased]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.10.2...HEAD
[0.10.2]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.5.0...v0.10.1
[0.5.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SMMURDA/zero-telegram-bridge/releases/tag/v0.1.0
