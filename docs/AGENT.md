# The agent

This document describes what the loop actually does, the data it relies on, and how to extend it. It
is written against the code in `electron/main/agent/` and `shared/`, not an intended design.

## The loop

`runAgent()` in `electron/main/agent/agent.ts` owns one turn:

1. **Build machine context.** Frontmost app, running apps, battery, volume, remembered facts,
   recalled exchanges and the previous task state.
2. **Plan.** `planForTurn()` ranks tools by description and looks for a playbook. A short plan with
    accepted tools and a definition of done is produced without a model call. Trivial requests get a
    single-step plan; an underdetermined request may allow one clarification question.
3. **Prefetch.** Safe, zero-argument reads that a plan step needs are run before the first model
   round. Their output enters the prompt as evidence. If the prefetch covers every step, the first
   model round starts with tools closed so the model answers instead of re-reading.
4. **Stream.** A shortlist of the best tools plus a small core set is sent with the prompt. The
   shortlist is an optimisation: a call to an unlisted tool still executes.
5. **Execute.** Read-only calls marked `parallelSafe` run in batches of three. Confirmations, clicks
   and any call that depends on the previous result run alone.
6. **Verify.** After each batch, `verifyPlan()` compares tool evidence with the plan. A blocked step
   gets one repair through `replanPlan()`; a step that cannot be repaired is reported.
7. **Answer.** Before the answer is accepted, `answerGap()` checks required steps and citations. The
   final allowed round closes the toolbox and forces an answer.

Budgets are per turn: 16 tool rounds / 240 s normally, 8 rounds / 600 s for a research plan. Tool
results are capped before they re-enter context. A turn that exhausts its budget keeps its objective
for the next turn.

### Stalling

A reply that announces work instead of doing it ("Let me check…", "Would you like me to open…?") is
not accepted. The loop nudges the model with a directive to act, up to twice, and **discards the
deferred draft** so the model does not read its own excuse back. The rule lives in
`agent/refusals.ts` and `agent/tool-policy.ts` and is tested without a model.

## Plans

`shared/plan.ts` defines the plan. It is intentionally small.

```ts
interface Plan {
  version: 1
  objective: string
  steps: PlanStep[]
  source: 'playbook' | 'heuristic' | 'generic'
  playbookId?: string
  allowQuestion: boolean
  requireCitations?: number
  requireCitationHosts?: number
  createdAt: number
}

interface PlanStep {
  id: string
  title: string
  kind: 'gather' | 'act' | 'verify' | 'answer' | 'clarify'
  tool?: string
  accept?: string[]        // any successful call in this set satisfies the step
  requiresEvidence?: boolean // a URL must have been seen this turn
  optional?: boolean       // a failure never blocks the answer
  note?: string
}
```

Verification is deterministic:

- `stepSatisfied` — an accepted tool succeeded, evidence exists if required, and the reply is long
  enough for an answer step.
- `stepFailed` — a step's accepted tools were attempted and none succeeded.
- `verifyPlan` — returns done, open and failed steps.
- `replanPlan` — replaces one blocked step with an alternative that the planner found, and records a
  note. It does not retry the same call forever.
- `answerGap` — returns a human-readable reason when the final text does not cover the plan or the
  required citations.

## Playbooks

A playbook is data. It is validated by `validatePlaybook()`, ranked by `rankPlaybooks()` against the
request (keywords, examples, title and description), converted into the same `Plan` as a heuristic
plan, and injected as steps only.

```json
{
  "version": 1,
  "id": "research-brief",
  "title": "Research brief",
  "description": "Answer a question from several live sources and cite the ones actually read.",
  "keywords": ["research", "sources", "current state", "landscape"],
  "examples": ["Research the current state of local LLM runtimes and cite two sources"],
  "steps": [
    { "title": "Search several angles", "kind": "gather", "tool": "research" },
    {
      "title": "Open the strongest source if a gap remains",
      "kind": "verify",
      "tool": "web_read",
      "requiresEvidence": true,
      "optional": true
    },
    { "title": "Answer with the URLs actually read", "kind": "answer" }
  ],
  "requireCitations": 2,
  "requireCitationHosts": 2
}
```

Rules: 1–6 steps, at most 20 keywords/tool names per list, tool names must match
`^[a-z][a-z0-9_]*$`, and an `answer` step should be last. Seed playbooks live in `playbooks/`. A
person's playbook is stored in the data directory; saving a new one uses `save_playbook`, which is a
confirmation-gated tool.

Adding a playbook:

1. Add `playbooks/<id>.json`.
2. Run `npm run evals` — it validates every playbook before running cases.
3. If it describes a new class of task, add an eval case in `evals/cases.ts`.

## Tool envelopes

Every tool result is normalised by `shared/tool-envelope.ts`:

```ts
type ToolErrorKind = 'unknown_tool' | 'invalid_args' | 'denied' | 'timeout' | 'failed'

interface ToolEnvelope {
  ok: boolean
  data: string
  truncated: boolean
  next_hint?: string
  error_kind?: ToolErrorKind
}
```

The loop uses the fields rather than parsing prose:

| Signal | Loop response |
| --- | --- |
| `ok: true`, `truncated: true` | use the result, follow `next_hint` if a further read is needed |
| `error_kind: 'timeout'` or `'failed'` | one retry for a transient-shaped failure, then replan |
| `error_kind: 'invalid_args'` | return the validation error to the model; it can correct the call |
| `error_kind: 'denied'` | stop the action; a denial is final, not a retry |
| `unknown_tool` | offer the registry through `discover_tools` |

`data` is the text the model sees. Tool-specific summaries and timings are kept for the trace and the
UI; they do not re-enter the model context.

## Tool selection

`shared/tool-router.ts` scores every tool against the request using its name, description and
arguments. The best eight plus a small core set are offered. The shortlist is never a permission
boundary — an unlisted call still executes and is logged as `unlisted tool called`.

`discover_tools` searches the whole registry on demand and returns matching schemas. Use it when the
model needs a capability that is not in the shortlist.

## Approvals and risk

Each `ToolDef` declares `risk: 'safe' | 'confirm'`. `executeTool` pauses a confirm-gated call and asks
the chat window. The dialog shows the exact command or arguments; denial is returned to the model as
a final result. Confirmation has a 60-second timeout that resolves to "no".

`run_shell` also runs a destructive-command blocklist before execution, regardless of approval.

## Background jobs

The `job` tool has four actions: `start`, `list`, `output`, `stop`. A job runs one existing tool
outside the current model round. It keeps the nested tool's validation, confirmation and timeout;
it is not a shell and cannot start another job. Use a job for a long read that would otherwise hold
the turn at its time limit.

## Task state

`agent/task-state.ts` persists the objective, plan, completed steps, URLs and failures to
`data/tasks.json` after each tool batch. A compact copy is re-injected into the prompt, so the model
stays oriented without replaying pages. Task state is not a second agent loop; it is a durable record
used by the same loop, and an interrupted turn can resume from it.

## Memory

- **Facts** — explicit items the person asked Lux to remember (max 60).
- **Exchanges** — a rolling log (max 400 entries). Recall is lexical by default. Semantic recall is
  opt-in in Settings because it loads `nomic-embed-text` and adds an embedding call per turn.

## Evals

```bash
npm run evals
```

`evals/cases.ts` defines 30 deterministic cases with machine-checkable outcomes over a fixed tool
set: planning, tool choice, verification, repairing a blocked step, citations, clarifying an
ambiguous request, and job lifecycle. `evals/check.ts` evaluates them without a model or network.
The suite also validates every playbook.

Add a case when you fix an agent bug: a regression that only appears with a real model will not be
caught here, so pair it with a benchmark task when the behaviour matters.

## Adding a tool

1. Create a `ToolDef` in the relevant module under `electron/main/tools/` and export it from that
   module's array.
2. Use an imperative description. It is what retrieval scores against.
3. Declare `risk: 'confirm'` for anything irreversible, and `parallelSafe: true` only for a call with
   no side effects.
4. Return a result through `executeTool`; do not catch validation or approval.
5. Add a `tests/` case for pure argument handling and an `npm run audit` case for the live
   integration.
6. Update `docs/TOOLS.md`.

## Debugging a turn

`~/Library/Application Support/Lux/logs/turns.jsonl` records the offered tools, every call with its
status and duration, nudges, rounds, plan verification and per-model-round wall, prompt, eval and load
times with cache reuse. Read it before changing the loop. A single tool can be exercised without a
model:

```bash
LUX_SMOKE_TOOL=play_music LUX_SMOKE_ARGS='{"tracks":"…"}' npm run smoke
```
