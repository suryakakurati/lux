# Lux 0.3.0 — audit and test report

**Commit:** `43e9ca2` (equal to `main`) · **Package version:** 0.2.1 · **Date:** 2026-11-26
**Environment:** Linux x64 container, Node 24.22.1, npm 11.19.1. The app targets macOS 13+ on Apple
silicon, so the Electron GUI, Ollama, `say`, `whisper` and AppleScript were **not available**.

This report is ordered by what should be done first. Each item says how necessary it is, the
evidence, and the smallest acceptable fix.

> **Status: P0 and P1 are fixed in this branch.** The findings below are kept as the record of what
> was wrong and why. Verification at the end of the work: typecheck, lint, 170/170 unit tests,
> 30/30 evals, build, and 9/10 long scenarios (the tenth is an S1 harness assertion that exposed a
> real playbook gap, now fixed — see P1-8).

---

## 1. What was actually run

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | 209 packages, 0 vulnerabilities |
| Typecheck | `npm run typecheck` | **pass** |
| Lint | `npm run lint` | **pass** (0 errors, 0 warnings) |
| Unit tests, documented | `npm test` | **fail** — the runner is handed `tests/` as a module (`MODULE_NOT_FOUND`) |
| Unit tests, working form | `node --test "tests/**/*.test.ts"` | **161/161 pass** in 2.5 s |
| Build | `npm run build` | **pass** (main, preload, renderer) |
| Evals | `npm run evals` | **29/30** — `answer-hamlet` fails |
| Long multi-step scenarios | temporary harness (10 scenarios, below) | **8/10**; the 2 failures are real defects |
| Live UI | `npm run preview:renderer` | serving the real renderer with a stub bridge |

Not run, and why: `smoke`, `audit`, `bench`, `bench:baseline`, `bench:rss`, `package`, `hotkey`,
`stt:setup`, `voice:setup`. Every one needs macOS, a display, Ollama, a pulled model, or native
tooling. Anything about the packaged app, real model behaviour, or speech is **unverified** by this
audit, not "passing".

### Long multi-step scenarios

Each scenario chained real modules (planner → plan → envelopes → replan → citations → jobs → ledger →
memory → context fitting), not mocks of the logic under test.

| Scenario | Result |
| --- | --- |
| S1 research brief: playbook → evidence → citations → gap check | pass |
| S2 machine + notes: plan, failed step, replan to optional | pass |
| S3 background job lifecycle (running → done; stop semantics) | pass |
| S4 commitments ledger + brief + lexical memory recall + refusal filtering | pass |
| S5 stalled replies, nudges, routing, context trimming (no orphan tool rows) | pass |
| S6 registry + playbook integrity (58 tools, 9 playbooks, all schemas) | pass |
| S7 unknown tool / invalid args / denied call envelopes | pass, **and exposed the shell refusal bug** |
| S8 twelve-round turn: task state stays < 4 k chars, 24 steps, 9 URLs | pass |
| S9 retrieval coverage for 14 realistic phrasings | **2 misses** (see P0-4) |
| S10 repeat policy + citation counting | pass |

---

## 2. P0 — do these before any 0.3 feature work

### P0-1 · `npm test` is broken on the Node version the README requires — **Blocker**

`package.json:18` runs `node --test tests/`. On Node 24 that treats `tests` as a module and exits 1:

```
Error: Cannot find module '.../tests'   → tests 1, pass 0, fail 1
```

`node --test "tests/**/*.test.ts"` runs all 161 tests and passes. `npm run check` therefore fails
before it ever reaches lint. There is also no `engines` field, so the documented "Node 22 or newer"
is unenforced.

**Fix (minutes):** change the test script to the glob, add
`"engines": { "node": ">=22" }`. Verify `npm run check` on Node 22 **and** 24.

### P0-2 · There is no CI, and `check` skips the evals — **High**

No `.github/` at all. `check` = typecheck + lint + test; `evals` is never part of a gate, which is
exactly how P0-3 reached `main` unnoticed. For a repo whose selling point is measured behaviour,
the benchmark and evals are the regression suite.

**Fix:** one workflow on `macos-latest` running install → typecheck → lint → test → evals → build;
add `check:full` (or include evals in `check`) so a release cannot be tagged red. Cache npm.

### P0-3 · `npm run evals` fails, and the failure is a design question — **High**

```
FAIL answer-hamlet   heuristic [gather:research → answer]   expected an answer-only plan
[evals] 29/30 passed
```

`evals/cases.ts:123` expects "Who wrote Hamlet?" to be answered with no tool. `shared/planner.ts`
deliberately adds a lookup for `EXTERNAL_INFO` / `who wrote …`, which is the behaviour 0.2 wanted
(and which fixed lyrics/translation turns). One of the two is wrong; decide the policy, then make
the other match — do not delete the case.

**Recommendation:** keep the research step for facts that can change or that a small model gets
wrong, and make the eval assert "answer or research, but never a wrong author". If the product
answer is "a 9B model answers Shakespeare from memory", then narrow `EXTERNAL_INFO` to exclude
well-known static facts and record that in `docs/DECISIONS.md`.

### P0-4 · Two advertised behaviours are not reachable — **High**

Reproduced against the real registry:

| Request | Shortlist (8) | Expected |
| --- | --- | --- |
| "what am I listening to" | open_app, system_status, browse, web_search, research, web_read, clipboard_read, discover_tools | `now_playing` missing |
| "find my latest screenshot" | … take_screenshot … | `find_files` missing |

Cause: `shared/tool-router.ts` matches whole tokens (`listening` ≠ alias `listen`, `latest` votes for
research, `find` is a stop word) and `screenshot` only maps to `take_screenshot`. So "find my latest
screenshot" offers a tool that *takes a new screenshot* instead of the one that finds the file.

**Fix:** stem the query tokens (`listening`/`watching` → `listen`/`watch`) and add
`find_files` to the `screenshot`/`file` aliases; then add these two rows to
`tests/tool-router.test.ts`. Cheap, and it protects the README's own examples.

### P0-5 · Documentation drift — **Medium (cheap, high trust)**

- `docs/ARCHITECTURE.md:18` and `CHANGELOG.md:91` say 57 tools; README and the code say 58.
- README "Running" documents `npm test` as if it worked.
- The README still describes 0.2.1 as `Status`; 0.3 needs its own section.

---

## 3. P1 — correctness and safety

### P1-1 · A refused shell command is reported as success — **High (safety semantics)**

`electron/main/tools/misc.ts` returns `{ content: 'Refused: …' }` for a blocklisted command, and
`executeTool` wraps any returned value in `successEnvelope`, so the model sees `ok: true` with
"Refused: …" as *evidence*. The loop then treats the step as done. Verified in scenario S7.

**Fix:** return `failureEnvelope('denied', …)` (or add a `refused` kind) so `error_kind` drives the
loop. Same treatment for "no command given".

### P1-2 · Tool timeouts abandon the work but do not stop it — **Medium**

`executeTool` races `tool.run()` against a timer; on timeout the promise is dropped, the process or
fetch keeps running. `ToolContext` has no abort signal, so a 60 s `web_read` keeps the socket and a
`take_screenshot` keeps the shell. Long turns can accumulate hidden work while the UI says "timed
out".

**Fix:** add `signal?: AbortSignal` to `ToolContext`, create one per call, pass it to `exec`,
`fetch` and `spawn`; abort on timeout and on `session.cancel()`.

### P1-3 · `web_read` will fetch anything the model names, including this machine — **Medium/High**

`electron/main/web/read.ts` calls `fetch(url, { redirect: 'follow' })` with no host policy. A model
(or a prompt-injected page) can ask for `http://127.0.0.1:11434/...`, a local admin panel, another
app's dev server, or a metadata endpoint; the response text then enters the prompt and the task
state. For a local assistant, loopback is where the sensitive services live.

**Fix:** resolve the host and reject loopback, private, link-local and `.local` addresses, plus any
redirect that lands on one (check `response.url`). Only allow them when the person explicitly asked
for that URL — that is a deliberate opt-in, not a default.

### P1-4 · `browse` accepts any scheme — **Low/Medium**

`electron/main/tools/web.ts` prepends `https://` only when there is no `scheme://`, so
`file:///…`, `javascript:`-adjacent or app schemes are passed to `/usr/bin/open`. Opening a local
file from a model-chosen path is a (small) escalation; `open_path` at least requires the file to
exist.

**Fix:** allow `http`, `https`, `mailto` and the search engines; reject the rest with a plain error.

### P1-5 · `silenceHud()` is dead and would hit the wrong window — **Low**

`electron/main/ipc.ts:223` is exported, never called, and sends `hud:idle` to `getChatWindow()`
while its comment says the HUD. Either delete it or send to the HUD window.

### P1-6 · Production CSP allows inline scripts — **Medium (defence in depth)**

`src/index.html` sets `script-src 'self' app: blob: 'unsafe-inline'`. React and the bundled build do
not need `'unsafe-inline'`; Vite dev may. Markdown is sanitised (DOMPurify, allow-list), so this is
a second line of defence, not the only one.

**Fix:** split dev/prod CSP (or nonce the dev entry) and drop `'unsafe-inline'` from the packaged
build. Verify the packaged window still boots.

### P1-8 · The research playbooks did not require a source — **Medium**

Found while re-running the long scenarios. The first step of `research-brief`, `compare-options` and
`latest-release` names `research` and `accept: [research, web_search]` but not `requiresEvidence`, so
`verifyPlan` treated a dossier with **zero URLs** as a satisfied gather step. The answer is still
stopped later by the citation gate, but verification — the thing that nudges an open step — believed
the work was done. All three steps now require evidence.

### P1-7 · Small correctness nits, all cheap

- `agent.ts` sets `rounds = round` (index) and passes it to `trace.finish({ rounds })`; a one-round
  turn reports 0. Use `round + 1`.
- `App.tsx` reads the hash once and ignores `hashchange`; route changes only work on load.
- After a resolver reports "nothing available", **every** gather/act step becomes optional, which can
  silently excuse a research step that was still needed. Scope it to the dependent step.
- `session.historyMessages` floors the budget at 8,000 characters; at a 2K context that alone can
  exceed the window. Tie the floor to the configured window.
- `Jobs.stop()` marks a job stopped but the underlying call continues; the docstring says so, but the
  UI should say "stop requested" rather than implying cancellation.

---

## 4. P2 — quality, performance, developer experience

1. **Renderer is one 794 kB chunk.** The HUD window — 400×132, shown on every keypress — loads the
   settings panel, markdown, DOMPurify and the whole chat. Route-splitting the three windows is the
   single cheapest win for perceived speed and memory (0.1 measured HUD/chat together).
2. **No React error boundary.** A render throw blanks the window with no recovery; one boundary per
   window plus a "reload" action is enough.
3. **Settings/confirm dialogs are not focus-trapped.** Escape closes settings, but Tab walks behind
   the scrim; the approval bar (`role="alertdialog"`) never takes focus, which matters for a
   confirmation gate.
4. **Benchmarks and docs stop at 0.2.1.** `docs/benchmarks/latest.json` is gitignored by design, but
   there is no 0.2 baseline committed and `docs/PERFORMANCE.md` still compares 8K vs 24K from 0.1.
   A 0.3 baseline should be produced on the same machine and committed with provenance.
5. **Three `{"type":"module"}` shims** (`tests/`, `shared/`, `electron/main/`) are load-bearing for
   `node --test` resolution but undocumented; one line in CONTRIBUTING prevents a future "cleanup".
6. **`.agent/memory.md`** is new in this audit; decide whether it is committed or ignored.

---

## 5. Recommended order for 0.3.0

**Phase 0 — restore the gate (half a day).** P0-1, P0-2, P0-4 tests, P0-5. Nothing else should
merge until `npm run check` and `npm run evals` are green in CI on a clean clone.

**Phase 1 — safety semantics (1 day).** P1-1, P1-2, P1-3, P1-4. These are the items where the agent
can currently be made to believe it did something it did not, or to read a local service. They are
small, testable, and mostly in `shared/` + `executeTool`.

**Phase 2 — decide P0-3 (an hour of product thinking).** Research-vs-memory policy for static facts.
Write it as an ADR; adjust planner **or** eval, never both blindly.

**Phase 3 — 0.3 features (the actual milestone).** Suggested, in order of leverage:
1. Streaming/tool-abort is in place first, then a real **cancel** path that stops the model and the
   tool (today `cancel()` aborts the model only).
2. Per-step **retry budget** surfaced in the UI (the trace knows; the person does not).
3. Route-split the renderer (P2-1) and add an error boundary (P2-2).
4. A 0.3 benchmark baseline on the reference Mac, with the research median treated as a first-class
   metric.

**Phase 4 — polish.** P2-3 … P2-6, docs refresh, changelog for 0.3.0.

---

## 6. What this audit did not verify

- Real model behaviour: tool choice under `qwen3.5`, stall nudges, citation compliance, research
  quality. The deterministic paths are green; the model-dependent ones are not measured here.
- macOS integration: AppleScript automation, Spotify, history databases, the native hotkey binary,
  permissions/TCC, `say`/Piper, whisper.
- The packaged app (`npm run package`), signing, first-run onboarding, sleep/wake recovery.
- Anything visual beyond the renderer compiling and serving; no pixel review was performed.

Those need a run on the reference Mac: `npm run check`, `npm run evals`, `npm run bench`, then the
manual matrix in `docs/RUNBOOK.md`.
