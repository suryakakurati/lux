# Architecture

Lux is one Electron app with a strict split: pure policy in `shared/`, macOS and Electron effects in
`electron/main/`, and the interface in `src/`. The split exists so the awkward decisions — planning,
name matching, queue advancement, citation checks, repeat calls — can be tested without a model, a
browser or Spotify running.

## Processes and windows

```
native/hotkey (Swift, CGEventTap, listen-only)
        │ NDJSON: down / up / chat
        ▼
Electron main
  ├── Session ────────────── conversation state, turn pipeline, commitments, brief delivery
  ├── EngineSupervisor ───── starts and watches Ollama, publishes engine state
  ├── Agent loop ─────────── planner, shortlist, stream, tools, verification
  ├── Tool registry ──────── validation, approval, timeout, 58 tools
  ├── Background jobs ────── detached work with progress and cancellation
  ├── Memory ─────────────── lexical recall by default; semantic opt-in
  └── STT ────────────────── whisper-cli → whisper → mlx
        │
        ├──▶ HUD window        (hold right ⌥, never focused)
        └──▶ Chat window       (⇧ + right ⌥)
```

The renderer never talks to Node directly. A preload script exposes a fixed `window.lux` bridge of
typed methods and one event stream; every window is sandboxed.

## The turn

```
Session.turn()                          electron/main/session.ts
   │  records the user item, captures commitments, builds machine context
   ▼
runAgent()                              electron/main/agent/agent.ts
   │  ┌─ planForTurn(objective, tools, playbooks)   shared/planner.ts
   │  ├─ bestPlaybook(goal, playbooks)              shared/playbooks.ts
   │  ├─ shortlist by description                   shared/tool-router.ts
   │  ├─ prefetch safe zero-argument reads          shared/plan.ts
   │  ├─ TaskStateStore.begin()                     agent/task-state.ts
   │  ├─ EngineSupervisor.ensure()                  agent/engine.ts
   │  ├─ ModelManager.prepare()                     agent/model-manager.ts
   │  ├─ buildSystemPrompt(context)                 agent/prompt.ts
   │  ├─ streamChat(ollama)                         agent/ollama.ts
   │  ├─ executeTool(name, args)                    tools/index.ts
   │  ├─ successEnvelope / failureEnvelope          shared/tool-envelope.ts
   │  ├─ verifyPlan / replanPlan                    shared/plan.ts
   │  └─ TurnTrace.finish()                         agent/trace.ts
   ▼
Session routes the reply to the HUD or chat, speaks it, records memory, persists the conversation.
```

Budget: 16 tool rounds and 240 s for an ordinary turn; a research plan gets 8 rounds and 600 s. The
final allowed round closes the toolbox and forces an answer. A turn that runs out of budget hands its
objective to the next one.

## Planning and verification

`shared/planner.ts` builds a plan without a model: it splits the request into clauses, ranks tools by
description overlap and playbook affinity, and emits steps with accepted tools and a definition of
done. `shared/plan.ts` owns verification:

- `stepSatisfied` checks the evidence a step expected (a matching tool call, a URL, a minimum answer
  length).
- `stepFailed` identifies a step that is blocked rather than merely unstarted.
- `verifyPlan` returns the open and failed steps.
- `replanPlan` repairs one blocked step with an alternative tool instead of retrying it.
- `answerGap` rejects a final answer that does not cover required steps or required citations.

Trivial requests skip the plan entirely. The planner is deterministic so it can be tested without a
model (`tests/planner.test.ts`, `tests/plan.test.ts`).

## Playbooks

`playbooks/*.json` are human-readable procedures. `shared/playbooks.ts` validates them and ranks them
against the request; `electron/main/agent/playbooks.ts` loads the directory and stores approved new
drafts. Only the best one or two are injected, and only their steps — not the whole library.

A playbook has an id, title, description, keywords, examples, optional citation requirements and
steps. A step names a kind (`gather`, `verify`, `act`, `answer`), an accepted tool set, and whether
evidence is required. See `docs/AGENT.md` for the schema.

## Tools

Every tool is a `ToolDef` with a JSON-Schema subset, a risk level and an optional timeout.
`executeTool` wraps every call:

1. `validateArgs` rejects unknown or invalid arguments.
2. `risk: 'confirm'` asks the person; a refusal is final and is reported to the model.
3. The call runs under a hard timeout (60 s by default).
4. A thrown error becomes an error value, never a broken turn.
5. Results are normalised into an envelope:

```ts
{
  ok: boolean
  data: string
  truncated: boolean
  next_hint?: string
  error_kind?: 'unknown_tool' | 'invalid_args' | 'denied' | 'timeout' | 'failed'
}
```

The loop uses `error_kind` and `next_hint` to decide whether to retry once, replan, or ask. Read-only
tools marked `parallelSafe` run in batches of three; confirmations and dependent actions stay
sequential.

`discover_tools` exposes the full registry on demand, so the shortlist never hides a capability.

## Background jobs

`electron/main/jobs.ts` runs detached work with an id, progress, a result and a cancel function. The
`jobs` tool starts, lists, inspects and cancels them; completion is reported as a notification and
appears in the conversation. A job is for work that would otherwise hold a turn at its time limit,
not a second agent loop.

## Memory and proactivity

Explicit facts and a rolling exchange log are stored in `data/memory.json`. Recall is lexical by
default; semantic recall uses `nomic-embed-text` only when enabled, because it competes for unified
memory on a 16 GB machine.

Commitments are captured by rule from explicit first-person language, with parsed due dates and
deduplication. The 30-second scheduler delivers a deterministic morning brief at the configured time,
respects quiet hours, skips during a running turn and records delivery in `data/proactive.json`. It
never calls a model.

## Modules

| Path | Responsibility |
| --- | --- |
| `shared/` | Pure logic: planning, playbooks, tool ranking, envelopes, citations, routing, validation, commitment dates, benchmark checks |
| `electron/main/index.ts` | App lifecycle, windows, protocol, shortcuts, tray, `--ask`, capture hooks |
| `electron/main/session.ts` | Conversation state, turn pipeline, commitments, brief delivery, approvals, persistence |
| `electron/main/agent/` | Loop, prompt, streaming client, engine supervision, model lifecycle, memory, task state, playbooks, trace |
| `electron/main/tools/` | Tool definitions and the execution wrapper |
| `electron/main/jobs.ts` | Background job registry |
| `electron/main/research.ts`, `web/` | Research dossiers, ranked search, page reading, browser window and history |
| `electron/main/music/` | Spotify resolution, history, optional Web API, player wrappers |
| `electron/main/mac/` | Small macOS primitives: exec, AppleScript, SQLite copies, stats, text search |
| `src/` | React renderer: chat, HUD, onboarding, design tokens and styles |
| `evals/` | Deterministic multi-step agent cases |
| `playbooks/` | Seed procedures |

## Storage

All state is atomic JSON under `~/Library/Application Support/Lux/data/` (or `LUX_DATA_DIR`). Writes go
through a temporary file and rename. Conversations are capped at 40; a conversation holds at most 400
items. There is no database migration step.

## Invariants

- Pages, notes, database rows, clipboard text and track names are data, never instructions.
- Reading playback history must never start playback.
- Secrets stay in `data/settings.json` or the environment; they never enter the prompt, logs or
  renderer.
- A failure names the step that blocked it. It never claims a capability gap that a tool covers.
- No code path contacts a hosted model.

See `docs/AGENT.md` for the loop in detail and `docs/SECURITY.md` for the controls.
