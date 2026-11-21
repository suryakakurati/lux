# Changelog

All notable changes to Lux are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows semantic
versioning.

## [0.2.0] — 2026-11-21

Voice and command accuracy. Minor version: new tools and a new speech engine, plus fixes found by
testing every command type against the real model.

### Added

- Neural local voice (Piper) used by "Automatic" when no Premium or Enhanced macOS voice is
  installed; `npm run voice:setup` installs it under `~/.cache/lux`.
- Voice picker in Settings, showing each installed voice's language and quality tier.
- `read_note` reads a Lux note in full, so a note can be written and read back.
- `top_processes` ranks running processes by memory, with per-app totals.
- `find_files` returns size and modification time, newest first, and never returns a directory as
  the file someone asked for.

### Fixed

- A selected voice that has been deleted falls back to the automatic voice. `say` accepts an unknown
  voice, exits 0 and stays silent, so presence is checked before speaking.
- Whisper is found outside a login shell, and the Python CLI gets a PATH that can find `ffmpeg`;
  transcription failures report the engine's error instead of returning stderr as the transcript.
- The current date in context includes its year, so notes no longer invent one.
- The engine warms at the configured 24K context instead of Ollama's 4K default, so the first turn
  no longer reloads the model.
- A stored 1,536-token output cap migrates to the 4,096 default.
- The capability audit no longer checks a tool that does not exist (`list_timers`).

## [Unreleased]

### Fixed

- Lookups no longer become local file searches: generic request verbs (`find`, `get`, `show`) are
  not tool names, and an unmatched phrasing still offers research and search instead of four machine
  probes. The answer-only plan no longer hides every tool behind `discover_tools`.
- Search uses Brave's index first, with Bing RSS and Google News as fallbacks; the old feed returned
  an encyclopedia article and a clothing shop for a lyrics query.
- A query for "the current song" or "this page" is refused with the instruction to resolve the real
  title first, and a track request gets that hint directly.
- `quit_app` checks that the app is running before asking AppleScript to quit it, and terminates the
  process it found when Automation is blocked instead of reporting a permission failure.
- `browse` can target Firefox, Safari, Chrome, Brave, Arc or Edge instead of only the default browser.
- Context defaults to 16K (stored 8K values migrate), and conversation history is sized from the
  configured window instead of a fixed 7,000 characters.
- Failed and refused turns are no longer stored as memory, and asking again replaces the old reply
  rather than letting it compete on recall.

## [0.1.0] — 2026-11-21

This release turns the V.0 prototype into an agent with a planning loop, procedural memory, a
measured performance pass and a designed interface.

### Added

- Deterministic planner with a definition of done, per-step evidence checks, one blocked-step repair
  and an answer/citation gap check.
- Nine seed playbooks, playbook ranking, and approval-gated saving of new playbooks.
- Uniform tool result envelope: `ok`, `data`, `truncated`, `next_hint`, `error_kind`.
- Background jobs (`job` tool: start, list, output, stop) for work that would otherwise hold a turn.
- Planned prefetch of safe zero-argument reads, injected as evidence before the first model round.
- First-sentence speech for answer-only voice turns.
- 30 deterministic eval cases (`npm run evals`).
- Reproducible 20-turn benchmark with greedy decoding, three runs, strict per-task success, clean-tree
  provenance and separate research budgets.
- Calm native interface: light and dark themes, system typography, wine and rose surfaces from the
  project's color scheme, one crimson accent, plain-text replies, a quiet expandable tool trace, a
  redesigned settings panel and a minimal HUD.
- Appearance setting: System (default), Light or Dark, applied to every window and native control.
- Explicit empty, checking, offline, missing-model, missing-permission, error, streaming and approval
  states.
- Documentation set: architecture, agent, performance, design, security, troubleshooting, contributing,
  changelog.
- ESLint, Prettier, EditorConfig and a `check` script.

### Changed

- Tool routing and playbook selection replaced the remaining per-task intent regexes.
- The tool registry was consolidated to 57 tools, including browser primitives, a single `job` tool
  and a merged timer.
- Prompt layout is static-first and volatile-last for KV-cache reuse; the shortlist is capped at eight.
- Idle RSS in the focused performance run is 372 MB, down from 538 MB in the verified baseline.
- Settings now groups engine, model, voice, schedule, permissions, knowledge and Spotify.
- TypeScript is pinned to 6.0.x because `typescript-eslint` refuses to load on 7.0. The codebase
  typechecks cleanly under 6.0.3.

### Fixed

- A planner tie-break counted repeated description words, causing `set_volume` to be chosen for a
  volume question.
- A long research turn could exhaust its own context; results are now capped and the task block is
  replaced in place.
- A turn that ended without the required source URL is recorded as a failure instead of a pass.
- `preserve-caught-error`, useless assignments, unnecessary escapes and dynamic `require` calls found
  by the new linter.
- The browser helper's pagination regex now passes `\d` to the injected page script correctly.

### Removed

- The Sentinel visual language (reactor, glow, scan lines, mono telemetry, “on-device channel” copy)
  and the reactor component.
- Dead icon exports.
- Personal fixtures, course examples and a hardcoded local-database path from the tracked tree.

### Known issues

- `ollama-release` in the benchmark is flaky (2 of 3 runs passed); it ends without the required source
  URL rather than inventing one.
- The full 20-task benchmark has not been rerun since the Phase 2 changes.
- Packaging is ad-hoc signed and fails on iCloud-managed folders.
- A full hardware sleep/wake cycle has not been tested end to end.

[0.1.0]: https://github.com/suryakakurati/lux/releases/tag/v0.1.0
[0.2.0]: https://github.com/suryakakurati/lux/releases/tag/v0.2.0
