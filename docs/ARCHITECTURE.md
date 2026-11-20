# Architecture

Lux is one Electron app with a strict split: pure policy in `shared/`, macOS and Electron effects in
`electron/main/`, and the interface in `src/`. The split exists so the awkward decisions — name
matching, queue advancement, stall detection, repeat calls — can be tested without a model, a
browser or Spotify running.

## The turn

```
right ⌥ / chat
   │
   ▼
Session.turn()                          electron/main/session.ts
   │  waits for EngineSupervisor.ensure(), records the user item,
   │  builds a per-turn hint, broadcasts HUD state
   ▼
runAgent()                              electron/main/agent/agent.ts
   │  ┌─ shortlistTools(request)        shared/tool-router.ts
   │  ├─ TaskStateStore.begin()        electron/main/agent/task-state.ts
   │  ├─ ModelManager.prepare()        electron/main/agent/model-manager.ts
   │  ├─ buildSystemPrompt(context)     electron/main/agent/prompt.ts
   │  ├─ streamChat(ollama)             electron/main/agent/ollama.ts
   │  ├─ ToolCallAccumulator            electron/main/agent/accumulator.ts
   │  ├─ repeatDecision(previous)       electron/main/agent/tool-policy.ts
   │  ├─ executeTool(name, args)        electron/main/tools/index.ts
   │  ├─ mapLimit(3) for read-only calls shared/concurrency.ts
   │  └─ TurnTrace.finish()             electron/main/agent/trace.ts
   ▼
Session routes the reply to the HUD or the chat window, speaks it if requested,
records the exchange in memory, and persists the conversation.
```

The loop owns an objective and a budget (16 rounds, 240 s). A reply that announces work instead of
doing it is nudged to continue; the deferred draft is discarded so the model does not read its own
excuse back. A turn that runs out of budget keeps its objective for the next turn. The objective,
plan, completed steps, URLs and failures are written to `data/tasks.json` after each tool; a compact
copy is re-injected into the prompt, so the model does not need the whole transcript to stay oriented.
Task state is not a second agent loop: it is a small durable record used by the same loop.

Independent read-only tools (`parallelSafe`) are grouped and run with a ceiling of three. A click,
a form submission, a confirmation or any call that depends on the previous result runs alone.
Transient network-shaped failures receive exactly one retry; validated failures return to the model
as content so it can change approach.

## Modules

| Path | Responsibility |
| --- | --- |
| `shared/` | Pure logic with no Electron import: matching, queue decisions, completion classification, routing, validation, commitment dates and brief composition, types |
| `electron/main/index.ts` | App lifecycle, windows, protocol, shortcuts, tray, `--ask`, `LUX_SHOT` |
| `electron/main/session.ts` | Conversation state, turn pipeline, commitment capture, brief delivery, confirmation prompts, persistence |
| `electron/main/commitments.ts` | Durable JSON ledger and item lookup |
| `electron/main/proactive.ts` | 30 s quiet-hours-aware brief and due-reminder scheduler; no model |
| `electron/main/agent/` | Loop and helpers: prompt, streaming client, accumulator, repeat/retry policy, trace, lexical/semantic memory, task state, model lifecycle, Ollama process supervision, refusal detection |
| `electron/main/agent/engine.ts` | Starts Ollama when it is down, waits for the API, warms the configured model, polls and re-checks after sleep; publishes engine state to the renderer |
| `electron/main/tools/` | The 55 tool definitions; `index.ts` validates, confirms and time-limits calls; `discover_tools` exposes the rest on demand |
| `electron/main/research.ts`, `web/search.ts`, `web/cache.ts` | Multi-query research, two-provider ranked search, bounded fetches and TTL caches |
| `electron/main/music/` | Spotify: rendered search, play history and name cache, resolver, Web API client, player wrappers |
| `electron/main/music-queue.ts` | Watches playback and advances the local queue |
| `electron/main/web/` | Lux's Chromium window, public page reader, browser history |
| `electron/main/mac/` | Small macOS primitives: `exec`, AppleScript, SQLite copies, stats, text search |
| `src/` | React renderer: chat, HUD, onboarding, styles |

## Tool execution contract

A tool returns content, a one-line summary and optionally `openChat`. Errors are values, not
exceptions, so the model can read the failure and change course. Every call is wrapped by
`executeTool`:

1. `validateArgs` against the tool's JSON Schema subset.
2. If `risk === 'confirm'`, ask the person and stop on refusal. `browser_submit` uses this gate too.
3. Run with a hard timeout (60 s by default, `timeoutMs` per tool). A timeout returns an error
   result instead of freezing the turn.
4. Convert a thrown error into an error result.
5. In the agent loop, execute `parallelSafe` calls with `mapLimit(..., 3)`; never parallelise a
   confirmation or a dependent browser action.

Adding a tool: create a `ToolDef` in the relevant module under `electron/main/tools/`, export it from
that module's array, keep the description imperative, and set `risk: 'confirm'` if it is
irreversible. `tools/index.ts` picks it up automatically; `npm run audit` should gain a case.

## Music resolution

## Model lifecycle on 16 GB

`agent/engine.ts` owns the process around the model: it starts Ollama after a cold boot or a long
sleep, waits for `/api/tags`, and preloads the configured model with an empty `/api/generate` so the
first question is not a cold load. It polls every 20 s, repeats on `powerMonitor` resume/unlock, and
never touches a non-loopback URL.

`agent/model-manager.ts` assumes one working chat model. `/api/ps` is checked once at startup
(and at most once a minute before a turn), a replaced chat model is released, and the configured
primary model is kept warm with the keep-alive from Settings. Lexical memory is the default, so
`nomic-embed-text` is not loaded unless semantic recall is explicitly enabled. A configured
specialist is only reachable through `consult_specialist`, is refused when system memory is above
90%, and is released in a `finally` block. No background model inference runs.

The settings that matter are all in Settings → Model: primary model, optional specialist, context
window, max output tokens and keep-alive. A smaller context is the first thing to try if the Air is
under memory pressure; a larger one costs KV cache and does not make the model faster.

`music/resolve.ts` is the policy; the sources are injectable by module boundary:

```
direct URI → cache → play history → rendered Spotify search → Web API → failure
```

- `music/web-search.ts` owns one hidden `BrowserWindow`, serialises searches through a promise
  queue, extracts `/track/<id>` anchors after hydration, and remembers results for the session.
- `music/history.ts` reads Spotify's binary play history and names URIs from public embed pages,
  caching for 30 days.
- `music/spotify-api.ts` is optional and reports Spotify's own reason (`premium-required`,
  `forbidden`, `rate-limited`, …).
- `music/player.ts` isolates the AppleScript surface. New Spotify commands belong there, not in a
  tool.

`shared/music-queue.ts` decides what the watcher does; `music-queue.ts` performs it. The pure side
encodes end-of-track, mid-track pause, forward/backward skip, autoplay stray, cold start and ads.

## Debugging

| What | Where |
| --- | --- |
| Human log | `~/Library/Application Support/Lux/logs/lux.log` |
| Per-turn structured trace | `.../logs/turns.jsonl` (rotates at 2 MB) |
| Capability report | `.../logs/audit.json`, or `npm run audit` |
| One tool, real machine | `LUX_SMOKE_TOOL=play_music LUX_SMOKE_ARGS='{"tracks":"…"}' npm run smoke` |
| One model turn | `npm run smoke -- "play Heat Waves and Bones"` |
| Packaged one turn | `release/…/Lux.app/Contents/MacOS/Lux --ask "…"` |
| UI capture | `LUX_SHOT=/tmp/lux.png npx electron out/main/index.js` |
| Morning brief now | `LUX_BRIEF_NOW=1 npx electron out/main/index.js` |
| HUD brief capture | `LUX_SHOT_HUD=/tmp/lux-brief.png npx electron out/main/index.js` |

An unlisted tool called by the model still executes; the log records it as `unlisted tool called`.
That is deliberate: tool routing is an optimisation, never a permission boundary.

## Commitments

Commitment capture and delivery are deterministic by design. `shared/commitments.ts` owns the
rules: explicit first-person patterns, negation and question rejection, duplicate keys, due-date
parsing, quiet hours and the once-a-day brief window. `electron/main/commitments.ts` is only
persistence and lookup. The model can read and edit the ledger through the `commitments` tool, but
it does not decide what gets captured. `Proactive` wakes every 30 seconds, skips while a turn is
running, and records the delivered local day in `data/proactive.json` so a restart cannot repeat
the brief. The design adds no model or embedding work, which keeps it comfortable on a 16 GB M4.

## Invariants

- Web pages, notes, database rows, clipboard contents and track names are data, never instructions.
- Playback and reading are separate tools; reading history must never start music.
- Secrets stay in `data/settings.json` (or the environment) and never enter the prompt, logs or
  renderer.
- A failure names the step that blocked it. It never claims a capability gap that a tool covers.
