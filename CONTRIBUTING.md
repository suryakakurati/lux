# Contributing

Lux is a single-user, local-first macOS app. Changes must preserve that: no hosted model, no
telemetry, no cloud fallback.

## Setup

```bash
npm install
npm run hotkey
npm run assets
npm run stt:setup   # optional
npm run dev
```

You need macOS on Apple silicon, Ollama with a tool-capable model, Xcode Command Line Tools and a
local speech engine for voice work.

## Before you open a pull request

```bash
npm run check      # typecheck → lint → test
npm run evals      # deterministic agent cases and playbook validation
```

Run `npm run bench` when you change the agent loop, prompt, tool selection or the model settings. A
performance claim needs a measured comparison against a committed benchmark report, not a stopwatch
anecdote. `npm run bench:baseline` refuses a dirty worktree on purpose; keep that rule.

Run `npm run audit` for a change that touches a live macOS integration (music, browser, files, notes,
history). `npm test` needs no network or permissions; the audit does.

## Style

- TypeScript, strict mode, no `any` unless there is a comment explaining the boundary.
- Pure policy belongs in `shared/` and must be testable without a model, browser or Spotify.
- Electron and macOS effects belong in `electron/main/`. Renderer code belongs in `src/`.
- Prettier: `npm run format`. ESLint: `npm run lint`.
- Comments explain a constraint or a surprising decision, not what the next line does.
- Do not reformat unrelated files in a functional change.

TypeScript is pinned to **6.0.x**. `typescript-eslint` refuses to load on 7.0, and the whole tree
typechecks cleanly on 6.0.3. Do not bump the major without confirming that `npm run lint` still runs.

## Commits

Conventional commits: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`. Keep each
commit reviewable and say why the change was made.

A performance commit must include the before/after numbers from the same task set.

## Adding a tool

1. Add a `ToolDef` to the relevant module in `electron/main/tools/` and export it from that module's
   array.
2. Write an imperative description — retrieval scores against it.
3. Set `risk: 'confirm'` for anything irreversible. Set `parallelSafe: true` only for a read with no
   side effects.
4. Add a pure test for argument handling, and an audit case for the live integration.
5. Update `docs/TOOLS.md` and, if the capability is new, `docs/AGENT.md`.

## Adding a playbook

1. Add `playbooks/<id>.json`. Validate with `npm run evals`.
2. Keep it to six steps; put `answer` last.
3. Add an eval case if it describes a new class of task.

## Security-sensitive changes

Anything touching approval, the shell blocklist, browser submission, renderer isolation or untrusted
input needs an explicit test and a note in `docs/SECURITY.md`. A change that makes a destructive
action possible without approval is not acceptable, regardless of intent.

## Reporting bugs

Include the app version, macOS version, the relevant `turns.jsonl` record, and whether the packaged
app or `npm run dev` was used. Review logs before sharing; they contain prompts and tool output, but
no credentials.
