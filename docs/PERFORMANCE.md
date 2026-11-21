# Performance

All claims here come from the committed reports in `docs/benchmarks/`. Nothing in this document is an
estimate presented as a measurement.

## Method

- **Machine:** Apple M4 MacBook Air, 10 cores, 16 GB, macOS 26.
- **Model:** `qwen3.5:latest` through Ollama `0.40.3` on `127.0.0.1:11434`.
- **Tasks:** a fixed 20-turn set: 5 trivial, 5 one-tool, 5 multi-tool, 3 research, 2 ambiguous.
- **Decoding:** greedy — `temperature 0`, `top_k 1`, `top_p 1`, `repeat_penalty 1`, `seed 42`.
- **Runs:** three. A task passes only if every run passes; flaky tasks are reported, never averaged
  away.
- **Isolation:** a temporary data directory, a fresh commitment ledger, a temporary memory file and a
  tool context that denies every confirmation.
- **Provenance:** a baseline requires a clean worktree and records the commit, branch, diff hash,
  task-set hash, model digest, Ollama version and machine.
- **Cold start:** the chat model is unloaded before the run, so `coldStartMs` is a genuine cold start.
  Turn timings are warm-model timings.
- **Research budget:** research turns get 600 s inside the agent (900 s for the whole turn in the
  benchmark), versus 240 s for ordinary turns. Research is allowed to take a while; a trivial
  question is not.

Run it yourself:

```bash
npm run bench          # one run, dirty tree allowed, writes latest.json
npm run bench:baseline # three runs, refuses a dirty tree
npm run bench:rss      # idle RSS of the built app
```

## Verified V.0.1 baseline

`docs/benchmarks/v0.0.1-baseline.json` — commit `0999ac2`, three runs, verified:

| Metric | Result |
| --- | --- |
| Tasks passing every run | 19 / 20 |
| Turn runs passing | 59 / 60 |
| Median wall time | 20,768 ms |
| Median time to first token | 16,230 ms |
| Trivial median | 13,754 ms |
| One-tool median | 20,086 ms |
| Multi-tool median | 32,727 ms |
| Research median | 156,286 ms |
| Prompt tokens (median total) | 161,108 |
| Eval tokens (median total) | 2,943 |
| KV-cache reuse | 65% |
| Median model rounds | 2 |
| Cold start to engine ready | 5,343 ms |
| Idle RSS | 538 MB |

`ollama-release` passed two of three runs. The failing run used its round budget and ended without
the required source URL. It did not invent a citation. The benchmark exits non-zero and records the
failure.

The earlier V.0 report (`v0.0-baseline.json`) is marked `verified: false` and is retained only as
history; it is not a comparison baseline.

## Focused Phase 2 iteration

`docs/benchmarks/v0.1.0-phase2-focused.json` — eight tasks, three runs, commit `5874f7b`, dirty tree,
**not a verified baseline**. The comparison uses the same eight tasks from the verified run.

| Metric | Verified baseline subset | Phase 2 | Change |
| --- | --- | --- | --- |
| Median wall time | 15,998 ms | 8,640 ms | −46% |
| Multi-tool median | 29,550 ms | 9,919 ms | −66% |
| Trivial median | 11,961 ms | 6,185 ms | −48% |
| Median time to first spoken word | 19,239 ms | 8,640 ms | −55% |
| Median model rounds | 2 | 1 | −1 |
| Idle RSS | 538 MB | 372 MB | −31% |

All eight tasks passed all three runs. The idle RSS figure is a 60-second process-tree sample with
Ollama excluded.

**Scope warning:** the full 20-task suite has not been rerun since these changes. Treat the focused
numbers as evidence that the optimisations work on those tasks, not as a new verified baseline.

## What changed

### Planned prefetch

The planner knows which steps need a safe, zero-argument read. Those reads run before the first model
round and their output enters the prompt as evidence. On the focused tasks this removed a model round
from most multi-tool turns. When the prefetch covers every planned step, the first round starts with
the toolbox closed so the model cannot answer by reading the same thing again.

### Early speech

The first complete sentence is handed to `say` as soon as it exists, instead of waiting for the whole
reply. This is what moves time-to-first-spoken-word: the benchmark reports 8.6 s against a full turn
of the same length.

### Smaller, better-ordered prompts

- Static content first: system rules, then core tool schemas. Volatile content last: time, battery,
  frontmost app, recalled memory and task state. Earlier messages are never reordered or rewritten
  between rounds.
- The tool shortlist is capped at eight.
- Old tool output is capped and summarised rather than replayed. The task-state block is replaced in
  place instead of appended each round.
- Research returns a compact URL evidence block rather than full pages.

KV-cache reuse is read from Ollama's `prompt_eval_cached_count`. The verified baseline measured 65%
across the suite; the focused Phase 2 run measured 54% on a smaller, shorter turn set. Cache reuse is
a diagnostic, not a target on its own.

### One model at a time

Lexical recall is the default, so the embedding model is not resident. The model manager checks
`/api/ps` at startup and at most once a minute before a turn, releases a replaced chat model, and
keeps only the configured primary model warm. The optional specialist is loaded for one bounded call
and released in a `finally` block.

### Renderer cost

The settings panel only lists models when the engine is ready; stats update on the existing session
loop; and the HUD timer runs only while a state needs it. There is no animation loop in the
background.

## What is not claimed

- **Two-model tiering** (a 4B router plus the 6.6 GB model) was not adopted. Keeping a second model
  resident competes for unified memory on 16 GB, and no measurement showed it winning. The fast path
  is deterministic planning and prefetch instead.
- **The full suite is not rerun.** The verified baseline predates Phase 2.
- **Research is still slow.** A multi-source dossier can take two to three minutes on this machine.
  That is the cost of local inference over several pages, and the HUD shows elapsed time rather than
  pretending otherwise.
- **Cold start is unchanged** at roughly five seconds to a warm model. A 6.6 GB model has to load.

## Reading a slow turn

Open `~/Library/Application Support/Lux/logs/turns.jsonl` and look at the `kind: "model"` records:

| Field | What it tells you |
| --- | --- |
| `wallMs` | total round time |
| `promptEvalMs` | prefill cost; large prompts dominate the first round |
| `evalMs` | generation cost; long answers and long tool arguments |
| `loadMs` | cold model load |
| `promptEvalCachedCount` | how much of the prompt came from cache |

A first round with a high prefill and no cache usually means the prompt changed shape. A turn with
many rounds usually means a tool failed or the plan was not satisfied; check `plan` and `tools` in the
same record.
