# Changelog

All notable changes to Lux are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows semantic
versioning.

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
