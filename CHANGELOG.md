# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

> Releases up to v0.4.1 were tagged retroactively from the project's commit
> history. The package manifest version was unified in v0.4.1.

## [Unreleased]

Nothing yet.

## [0.4.3] - 2026-10-24

### Changed

- The release workflow now uses the matching `CHANGELOG.md` section as the
  GitHub release body, appending a compare link to the previous tag.
  Auto-generated notes remain the fallback when no section exists.

## [0.4.2] - 2026-10-24

### Added

- Automated GitHub release workflow: pushing a `v*` tag builds a source ZIP and
  creates a release with generated notes.

### Changed

- The versioning and release process is documented in the README.

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

[Unreleased]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SMMURDA/zero-telegram-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SMMURDA/zero-telegram-bridge/releases/tag/v0.1.0
