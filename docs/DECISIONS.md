# Decisions

Short records of the choices that shaped the codebase, with what was rejected.

## ADR-001 — Electron + React instead of Python/Qt or SwiftUI

**Decision.** Electron 45 + React 19 + TypeScript, one process, no Python runtime.

**Why.**
- Two prior projects split UI and logic across process boundaries (one Tauri + Python, one
  PySide6 + services). That split is where most of their complexity and failure modes live.
- The UI requirement is unusually high ("should not look vibe coded"). CSS gives exact control over
  type, hairlines, motion and spacing; QSS does not, and SwiftUI would be gorgeous but native-only
  with a much slower feedback loop.
- One language means one toolchain, one typecheck, one set of tests.

**Rejected.** PySide6 (styling ceiling), Tauri + Python sidecar (two runtimes, packaging pain),
pure SwiftUI (fastest UI, slowest iteration for an agent loop, harder to verify here).

## ADR-002 — Native Swift helper for the hotkey

**Decision.** Compile a ~120-line Swift binary with `CGEventTap` and read NDJSON from stdout.

**Why.** Electron's `globalShortcut` cannot see a modifier-only hold or key-up, which makes
hold-to-talk impossible. A native module (`uiohook-napi`) would add an ABI-sensitive dependency;
the helper is auditable, has no build-system risk, and compiles in seconds.

**Rejected.** `pynput` (Python dependency), `node-global-key-listener` (third-party binary),
Accessibility-dependent key monitors (broader permission than needed).

## ADR-003 — Input Monitoring, not Accessibility

**Decision.** Request Input Monitoring for a listen-only tap; never install a filtering tap.

**Why.** Apple's DTS guidance: a listen-only tap requires `kTCCServiceListenEvent`; Accessibility is
only needed to filter or post events. Lux must not be able to swallow keystrokes.

**Consequence.** The permission is granted per binary in development. Documented in the runbook.

## ADR-004 — Audio captured in the renderer

**Decision.** Record through an `AudioWorklet` at 16 kHz inside the HUD window.

**Why.** Chromium already owns the mic, the resampler and the TCC prompt. Doing it in Node would
require a native audio module and a second permission path. WAV is encoded in-process, so ffmpeg is
not a runtime dependency.

**Mitigations.** `backgroundThrottling: false`, show-before-capture, a primed persistent stream, and
a peak-amplitude watchdog (silence is an error, not an input).

**Rejected.** `MediaRecorder` (webm/opus, lossy, needs ffmpeg), a Python audio service (second
runtime).

## ADR-005 — Ollama tool calling, no custom grammar

**Decision.** Use native `/api/chat` function calling with `think: false`.

**Why.** Verified locally: qwen3.5 returns `tool_calls` with `arguments` as an object, and chains
tools correctly. Structured-output grammars were the alternative; tool calling is less brittle and
gives typed arguments plus a natural multi-step loop.

**Consequence.** Model choice matters — the app warns when Ollama or the model is missing and falls
back to the first installed chat model.

## ADR-006 — JSON files instead of SQLite

**Decision.** Atomic JSON for settings, conversations and memory.

**Why.** No native module (`better-sqlite3`) in the Electron ABI, and the data volume is tiny
(40 conversations, 400 memory entries). Writes go through `tmp` + rename.

**Revisit when** memory grows past a few thousand entries or full-text search over notes is needed —
at that point `node:sqlite` or an index file is the next step.

## ADR-007 — The model decides, the code enforces

**Decision.** The LLM chooses tools; the tool layer validates, confirms and blocks.

**Why.** Prompt-based safety ("don't run dangerous commands") is not a control. `validateArgs`
rejects unknown or out-of-range arguments, `risk: 'confirm'` pauses the turn, and `run_shell` has a
blocklist plus a timeout regardless of what the model asks for.

## ADR-008 — Rose-glass workspace with a wine rail, no theme switch

**Superseded by ADR-011.**

**Decision.** One light theme: a deep wine navigation rail beside a lit rose workspace, with
porcelain glass cards for the transcript. No theme switch in V.0.

**Why.** The product mockup is built on a single rose ramp where depth comes from light, not from a
second hue. The rail anchors navigation; the glass cards keep the workspace visible behind the text
without turning every control into glass. A dark variant should be *designed*, not inverted — that
is a later milestone.

## ADR-009 — Result routing as a pure function

**Decision.** `shared/router.ts` decides HUD vs chat from text length, structure and tool intent.

**Why.** The product rule ("either answer in chat or act") is policy, not UI code. Keeping it pure
makes it testable and tunable from settings without touching components.

## ADR-010 — No cloud fallback, ever

**Decision.** Every failure path reports a local error; nothing escalates to a hosted model.

**Why.** "Fully local" is the product. A silent cloud fallback would leak audio and text and destroy
the guarantee the onboarding screen makes.

## ADR-011 — Sentinel instrument UI, one ion signal

**Superseded by ADR-013.**

**Decision.** Replace the light rose/porcelain workspace with a near-black instrument panel: a glass
console rail, one ion-cyan accent, mono telemetry, a CSS reactor mark and short mechanical motion.
Amber means the engine is starting or waking; coral means a failure or an approval gate.

**Why.** The interface is a live agent console, and the telemetry, engine state and tool trace need a
surface that reads like instrumentation. A single accent makes state legible at a glance; layered
radials, a masked grid and 1 px hairlines give depth without heavy shadows. The old light system
could not carry the reactor/HUD language without becoming a second design.

**Rejected.** A light/dark switch (two designs to maintain), a neon "cyberpunk" palette (body text
stops being readable), decorative motion that delays work.

## ADR-012 — The engine supervisor owns Ollama's lifecycle

**Decision.** `agent/engine.ts` pings the local API, starts `Ollama.app` (falling back to the bundled
`ollama serve`), waits for it, loads the configured model with the keep-alive from Settings, polls
every 20 s and re-checks on power resume and unlock. `Session.turn()` awaits `ensure()` before the
model call. A manual **Wake** action is exposed in the banner and Settings.

**Why.** Ollama is a separate process. After a Mac has been off or asleep it can be gone while Lux is
still open, and the old failure was a raw fetch error after the person had already asked a question.
Recovering automatically makes the local-only guarantee usable without a manual step.

**Limits.** Only a loopback `ollamaUrl` is started; a remote URL is reported, never relaunched. Lux
does not pull models automatically because that can be a multi-gigabyte surprise. It never falls back
to a hosted model.

## ADR-013 — Calm native utility UI, not an instrument panel

**Decision.** Replace Sentinel with a neutral, system-typed desktop utility: light and dark themes
following macOS, a solid conversation sidebar, plain reply text, one blue accent for primary actions
and focus, a quiet expandable tool trace, and a compact 400×132 HUD. No reactor, glow, gradients,
scan lines or decorative animation.

**Why.** The agent's work is text and tool steps. Sentinel made the chrome louder than the answer and
read as generated decoration. A native utility is easier to read for long sessions, respects system
appearance and accessibility settings, and stops encoding state in ornament. Motion is now limited to
state changes of 120–160 ms and honours `prefers-reduced-motion`.

**Rejected.** Native vibrancy across the window (text contrast becomes unpredictable over the
desktop), an in-app theme switch (macOS already owns appearance), keeping the reactor as a brand mark
(decorative motion without information).

**Consequence.** Screenshots and UI copy are part of the review surface. `LUX_SHOT`, `LUX_SHOT_HUD`,
`LUX_SHOT_SETTINGS` and `LUX_THEME` make the real windows capturable without taking over the screen.

## ADR-014 — Deterministic plans and playbooks instead of more intent regexes

**Decision.** A cheap deterministic planner produces a short plan with accepted tools and a
definition of done. Retrieval selects one or two human-readable playbooks. Verification, one repair
and the citation check are pure functions in `shared/plan.ts`.

**Why.** A small local model needs structure to plan and recover, but adding a regex per request does
not generalise and cannot be tested against new phrasing. A plan is data: it can be verified against
tool evidence, repaired with a different tool, and shared by a playbook. The model still writes the
answer; code owns progress. Trivial requests skip planning, so the fast path stays fast.

**Rejected.** A second model call to plan every turn (cost and latency), per-task routing rules
(does not transfer), letting the model decide when it is done (it cannot reliably tell “finished”
from “said it would finish”).

## ADR-015 — One envelope for every tool result, and background jobs

**Decision.** Tool results are normalised to `ok`, `data`, `truncated`, `next_hint` and `error_kind`
(`unknown_tool`, `invalid_args`, `denied`, `timeout`, `failed`). Long work can run as a background
job through a single `job` tool.

**Why.** The loop needs to choose retry, replan or ask without parsing tool-specific prose. A stable
envelope makes that decision testable and keeps truncation visible. Jobs exist because a 240-second
turn budget should not be the limit for a long read; a job keeps the nested tool's validation,
approval and timeout, so it is not a bypass.

**Rejected.** Per-tool error strings parsed by pattern (brittle), a general shell-backed job runner
(would bypass the approval layer).

## ADR-016 — Pin TypeScript 6.x for the lint toolchain

**Decision.** The project compiles and typechecks with TypeScript 6.0.3, not 7.0.

**Why.** `typescript-eslint` refuses to load on TypeScript 7 at import time. The whole codebase
typechecks cleanly on 6.0.3, so pinning the compiler keeps a real lint pipeline (including
React hooks rules) instead of dropping linting or patching a dependency. Revisit when
`typescript-eslint` supports TS 7.

**Consequence.** Bumping the TypeScript major requires verifying `npm run typecheck` and
`npm run lint` together.
