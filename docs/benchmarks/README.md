# Benchmarks

The benchmark is a fixed 20-turn set run against the real local model. It exists
so every V.0.1 performance claim is compared with the same tasks, model, machine
and decoding rather than with a memory of how fast something felt.

## Running

```bash
npm run bench          # one run; writes docs/benchmarks/latest.json
npm run bench:baseline # three runs from a clean tree; writes v0.0.1-baseline.json
npm run bench:rss      # idle RSS; writes docs/benchmarks/idle-rss.json
```

`bench` builds first. It uses an isolated temporary data directory, a fresh
commitment ledger, a temp memory file, a temp playbook directory and a tool
context that denies every confirmation. It never plays audio, opens an app,
writes a real note or touches the real Lux data. The fixed tasks are read-only by
design.

`bench:baseline` refuses to start unless:

- the git worktree is clean (no modified, staged or untracked files),
- `HEAD` can be read,
- `LUX_BENCH_ONLY` is not set, so the full fixed task set runs.

That is the provenance rule: a committed baseline must name the commit that
produced it. A local `bench` run is allowed to be dirty and records the fact.

`bench` unloads the chat model before starting the engine so `coldStartMs` is a
genuine cold start. `bench:rss` starts the built app separately and waits for it
to settle; it never kills a Lux that was already running.

### Environment

| Variable | Meaning |
| --- | --- |
| `LUX_BENCH_ONLY` | Comma-separated task ids for a focused iteration. Never allowed for a baseline. |
| `LUX_BENCH_RUNS` | 1–5 runs. Default 1, and 3 for `bench:baseline`. |
| `LUX_BENCH_MODEL` | Override the model without editing settings. Recorded in the report. |
| `LUX_BENCH_OUT` | Report file stem (for example `trial-a`). Defaults to `latest` or `v0.0.1-baseline`. |
| `LUX_BENCH_BASELINE` | `1` enables the clean-tree rule. Set by `bench:baseline`. |
| `LUX_RSS_WAIT_MS` | Settle window for the idle RSS sample. Default 60 s. |

## Stability

Every measured turn uses greedy decoding: `temperature: 0`, `top_k: 1`,
`top_p: 1`, `repeat_penalty: 1`, `seed: 42`. The app keeps its normal sampling;
only the benchmark passes these options. Each task also starts from a fresh task
record, so a resumed plan from an earlier run cannot leak in.

Deterministic decoding removes sampling variance, not all variance. Network
responses, page content, OS scheduling and which public sources a search returns
can still change. That is why repeated runs exist:

- each task records every run's pass/fail and a `passRate`;
- `success` is strict: every run must pass, so a flaky task is not a win;
- wall time, TTFT and token counts are the median across runs;
- `summary` is computed from those per-task medians, and keeps trivial,
  one-tool, multi-tool and research medians separate;
- `flaky` lists tasks that passed some runs and failed others.

A task that is genuinely flaky is reported as flaky. It is not averaged away.

Research tasks have a longer budget than ordinary turns: 720 s inside the agent
and 900 s for the whole turn, versus 240 s and 300–360 s for the other
categories. Research is allowed to take a while; a trivial question is not.

Repeated runs keep the chat model resident. `coldStartMs` is measured once,
before run 1, so turn timings are warm-model timings and the cold start is
reported separately rather than being averaged into a turn.

Research tasks allow up to 8 model rounds; the other categories keep their
tighter caps. The ceiling exists to catch a loop, not to ration reading.

## Definitions

| Field | Definition |
| --- | --- |
| `wallMs` | `runAgent` start → final answer, median across runs |
| `ttftMs` | turn start → first non-thinking content token, median across runs |
| `ttfswMs` | turn start → the full reply is handed to speech. V.0 speaks only after the loop, so this equals wall time; Phase 2 changes it to the first sentence. |
| `promptTokens` | median of the sum of Ollama `prompt_eval_count` across model rounds |
| `evalTokens` | median of the sum of Ollama `eval_count` across model rounds |
| `cachedPromptTokens` | median of the sum of `prompt_eval_cached_count` |
| `cacheReusePct` | `cachedPromptTokens / promptTokens`, weighted across the turn |
| `rounds` | model rounds, including the final answer round |
| `toolRounds` | rounds that contained at least one tool call |
| `success` | `checkBenchTask` in `shared/bench.ts` passed in every run |
| `passRate` | percentage of runs that passed |
| `flaky` | `0 < passes < runs` |
| `citationsBacked` | distinct cited URLs that also appeared in tool output |
| `citationsUnbacked` | distinct cited URLs that never appeared in tool output |
| `coldStartMs` | benchmark process boot → engine reports `ready` with the model warmed |
| `idleRssMb` | sum of RSS across the app and all child processes after the settle window; Ollama is separate and not counted |

The per-turn result also includes the tool calls and their status, so a faster
turn that skipped a required read is visible rather than silently counted as a
win.

## Provenance

`meta` records:

- `schema` and `harness` version,
- `commit`, `branch`, `dirty` and `diffHash` (sha256 of the working diff plus the
  untracked file list),
- `verified`: true only for a baseline produced from a provably clean commit,
- `taskSetHash`: sha256 of the task prompts and checks,
- `runs` and `sampling`,
- `model`, `modelDigest` and `ollamaVersion`,
- `coldStartMs`, machine, Electron/Node and the relevant settings,
- the idle RSS sample's `source`, `sampleAt` and `stale` flag.

`v0.0-baseline.json` is kept as a historical V.0 measurement. Its provenance is
marked `dirty: true`, `verified: false`, `baseline: false` because it was
generated while the harness was still uncommitted. It is not a comparison
baseline.

## Task mix

- 5 trivial turns, including two that should use no tool at all
- 5 one-tool turns
- 5 multi-tool turns (success requires the named tools)
- 3 research turns. Each must cite exact source URLs that appeared in tool
  output; the two multi-source tasks require two distinct hosts. A bare `[1]`
  is not a citation, and an invented URL fails the task.
- 2 deliberately ambiguous turns; one may pass by asking one targeted question

## Caveats

- Single-machine measurements on an M4 MacBook Air, 16 GB. Not a controlled lab.
- Network tasks depend on the network and on the current state of public pages.
  Citation checks prove a URL was returned, not that its publisher is correct.
- The model is whatever `settings.model` names, or `LUX_BENCH_MODEL`; the report
  records the digest.
- A failed task is kept in the report with its reason. Do not average it away.
- `bench` exits non-zero if any task did not pass every run, but still writes the
  full report.

## Files

- `v0.0-baseline.json` — historical V.0 run, unverified provenance, kept as-is
- `v0.0.1-baseline.json` — verified V.0.1 baseline, clean commit, repeated runs
- `idle-rss.json` — the latest idle RSS sample with its commit and timestamp
- `latest.json` — the most recent single run, ignored by git
- `raw/*.raw.json` — full replies, cited URLs and tool summaries, kept local and
  ignored by git because clipboard text, file paths and page content can be
  personal. The committed report redacts them.
