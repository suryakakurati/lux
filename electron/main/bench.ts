/**
 * Reproducible benchmark harness for the local agent.
 *
 *   npm run bench           # one run, writes docs/benchmarks/latest.json
 *   npm run bench:baseline  # repeated runs from a clean tree, writes a baseline
 *
 * It uses the same `runAgent`, tool registry, prompt and Ollama client as the
 * app. Every task runs with an isolated data directory, a fresh task state, a
 * temp memory file and a tool context that denies every confirmation. Nothing
 * in the fixed task set plays audio, opens an app or writes to the real data.
 *
 * Measurements are only comparable when the code, model, task set and decoding
 * are known, so the report records all four: commit + dirty state, model digest
 * and Ollama version, a hash of the task set, and the sampling options. Bench
 * turns use greedy decoding with a fixed seed; repeated runs are reduced to
 * medians and a strict pass rate.
 *
 * Metrics come from the existing turn trace, not from estimates:
 *   - wall time and TTFT are measured in this process
 *   - prompt/eval tokens and cache reuse are read from Ollama's final chunk
 *   - rounds and tool calls come from the trace and AgentOutcome
 *   - citations are counted against URLs the tools actually returned
 */
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { BenchCategory, BenchSummary, BenchTask, BenchTurnResult } from '../../shared/bench'
import { aggregateBenchRuns, benchCitationCounts, checkBenchTask, summariseBench } from '../../shared/bench'
import type { AgentEvent, AgentOutcome } from './agent/agent'
import { runAgent } from './agent/agent'
import { EngineSupervisor } from './agent/engine'
import { Memory } from './agent/memory'
import { TaskStateStore } from './agent/task-state'
import { CommitmentLedger } from './commitments'
import { getSettings } from './config'
import { initLog } from './log'
import { batteryInfo, frontmostApp, outputVolume, runningApps } from './mac/stats'
import { toolDefinitions } from './tools'
import type { ToolContext } from './tools/types'
import { BENCH_TASKS } from './bench-tasks'

const HARNESS_VERSION = 2
/** Greedy decoding. A fixed seed makes any tie-break repeatable too. */
const SAMPLING = { temperature: 0, topK: 1, topP: 1, seed: 42, repeatPenalty: 1 }
const BASELINE = process.env.LUX_BENCH_BASELINE === '1'
const REQUESTED_RUNS = Number(process.env.LUX_BENCH_RUNS ?? (BASELINE ? 3 : 1))
const RUN_COUNT = Number.isFinite(REQUESTED_RUNS)
  ? Math.min(5, Math.max(1, Math.floor(REQUESTED_RUNS)))
  : 1

const TURN_TIMEOUT_MS: Record<BenchCategory, number> = {
  trivial: 300_000,
  'one-tool': 360_000,
  'multi-tool': 360_000,
  research: 900_000,
  ambiguous: 300_000
}
/** Research is allowed to take a while; an ordinary turn is not. */
const AGENT_BUDGET_MS: Record<BenchCategory, number> = {
  trivial: 240_000,
  'one-tool': 240_000,
  'multi-tool': 240_000,
  research: 720_000,
  ambiguous: 240_000
}

const bootAt = Date.now()
const benchRoot = mkdtempSync(join(tmpdir(), 'lux-bench-'))
const benchData = join(benchRoot, 'data')
mkdirSync(benchData, { recursive: true })
// config.dataDir honours this, so settings, tasks, commitments, memory and
// user playbooks all live in the temp directory. Logs and traces follow
// userData below.
process.env.LUX_DATA_DIR = benchData

app.setPath('userData', benchRoot)
app.setName('LuxBench')
app.dock?.hide()

interface TraceStep {
  kind: 'round' | 'model' | 'tool' | 'nudge' | 'stop'
  ms?: number
  metrics?: {
    promptEvalCount?: number
    promptEvalCachedCount?: number
    evalCount?: number
  }
}

interface TraceRecord {
  steps: TraceStep[]
}

interface GitInfo {
  commit: string | null
  branch: string | null
  /** null means it could not be determined, which is not the same as clean. */
  dirty: boolean | null
  diffHash: string | null
}

interface ModelInfo {
  digest: string | null
  ollamaVersion: string | null
}

interface IdleRssSample {
  at?: string
  idleRssMb?: number
  processes?: number
  waitMs?: number
  note?: string
}

interface ReportMeta {
  schema: number
  harness: string
  generatedAt: string
  startedAt: string
  endedAt: string
  durationMs: number
  command: string
  baseline: boolean
  /** True only when a baseline was produced from a provably clean commit. */
  verified: boolean
  commit: string | null
  branch: string | null
  dirty: boolean | null
  diffHash: string | null
  taskSetHash: string
  runs: number
  sampling: typeof SAMPLING
  model: string
  modelDigest: string | null
  ollamaUrl: string
  ollamaVersion: string | null
  coldStartMs: number
  toolCount: number
  machine: {
    platform: string
    arch: string
    cpu: string | null
    cores: number
    totalMemGb: number
    node: string
    electron: string
  }
  settings: {
    contextWindow: number
    maxOutputTokens: number
    modelKeepAlive: string
    memoryMode: string
    keepModelLoaded: boolean
  }
  idleRss: {
    idleRssMb: number | null
    source: string
    sampleAt: string | null
    stale: boolean
    note: string
  }
}

interface Report {
  meta: ReportMeta
  summary: BenchSummary
  samples: BenchSummary[]
  tasks: ReturnType<typeof aggregateBenchRuns>['tasks']
  idleRssMb?: number | null
}

const startedAtIso = new Date().toISOString()
const git = gitInfo()

async function main(): Promise<void> {
  await app.whenReady()
  initLog()

  if (BASELINE && git.dirty !== false) {
    console.error(
      git.dirty === null
        ? '[bench] refusing baseline: this is not a git worktree, so provenance cannot be proven.'
        : '[bench] refusing baseline: the worktree is dirty. Commit the harness first so the report names the code that ran.'
    )
    app.exit(2)
    return
  }
  if (BASELINE && process.env.LUX_BENCH_ONLY) {
    console.error('[bench] refusing baseline: a baseline must run the full fixed task set, not LUX_BENCH_ONLY.')
    app.exit(2)
    return
  }
  if (BASELINE && git.commit === null) {
    console.error('[bench] refusing baseline: HEAD could not be read.')
    app.exit(2)
    return
  }

  const base = getSettings()
  const settings = {
    ...base,
    model: process.env.LUX_BENCH_MODEL?.trim() || base.model,
    speechEnabled: false,
    proactiveEnabled: false,
    onboarded: true,
    memoryMode: 'lexical' as const,
    notesDir: join(benchRoot, 'notes'),
    vaultPath: '',
    agniDbPath: '',
    keepModelLoaded: true
  }
  mkdirSync(settings.notesDir, { recursive: true })

  // Cold-start measurement: unload the chat model, then let the supervisor
  // launch Ollama if needed and warm the model. This is process boot → ready.
  await unloadModel(settings.ollamaUrl, settings.model)
  const engine = new EngineSupervisor(() => settings, () => undefined)
  engine.start()
  const status = await engine.ensure('startup')
  const coldStartMs = Date.now() - bootAt
  if (status.state !== 'ready') {
    console.error(`[bench] engine not ready: ${status.detail}`)
    engine.stop()
    app.exit(1)
    return
  }

  const [apps, battery, volume, front] = await Promise.all([
    runningApps(),
    batteryInfo(),
    outputVolume(),
    frontmostApp()
  ])
  const machine = {
    runningApps: apps,
    battery,
    volume: volume ?? 50,
    frontmostApp: front
  }

  const memory = new Memory(join(benchRoot, 'memory.json'), () => ({
    url: settings.ollamaUrl,
    model: settings.embeddingModel,
    mode: settings.memoryMode
  }))
  const commitments = new CommitmentLedger(join(benchRoot, 'commitments.json'))
  const toolContext: ToolContext = {
    settings,
    commitments,
    confirm: async () => false,
    notify: () => undefined,
    speak: () => undefined,
    remember: () => undefined
  }

  const selected = selectTasks()
  const modelInfo = await readModelInfo(settings.ollamaUrl, settings.model)
  const idle = readIdleRss()
  if (idle.stale) {
    console.warn('[bench] the idle RSS sample is missing or older than 14 days; run npm run bench:rss')
  }

  console.log(
    `[bench] harness=${HARNESS_VERSION} model=${settings.model}${modelInfo.digest ? `@${modelInfo.digest.slice(0, 12)}` : ''} tasks=${selected.length} runs=${RUN_COUNT} sampling=temp${SAMPLING.temperature}/seed${SAMPLING.seed} coldStart=${coldStartMs}ms`
  )
  console.log(
    `[bench] commit=${git.commit ?? '?'}${git.dirty === false ? '' : git.dirty === true ? ' (dirty)' : ' (unknown dirty state)'} taskSet=${taskSetHash(selected).slice(0, 12)}`
  )

  const runs: BenchTurnResult[][] = []
  const samples: BenchSummary[] = []
  for (let run = 0; run < RUN_COUNT; run += 1) {
    if (RUN_COUNT > 1) console.log(`[bench] run ${run + 1}/${RUN_COUNT}`)
    // A fresh task store per run keeps a resumed record from one run out of the
    // next, without paying to rebuild the model or the engine.
    const tasks = new TaskStateStore(join(benchData, `run-${run}`))
    mkdirSync(join(benchData, `run-${run}`), { recursive: true })
    const results: BenchTurnResult[] = []
    for (let index = 0; index < selected.length; index += 1) {
      const task = selected[index]
      process.stdout.write(
        `[bench] ${String(index + 1).padStart(2, '0')}/${selected.length} ${task.id} … `
      )
      const result = await runTask(task, settings, memory, toolContext, tasks, machine)
      results.push(result)
      const tools = result.toolCalls.map((call) => call.name).join(',') || 'none'
      const citations = `${result.citationsBacked ?? 0}/${result.citedUrls?.length ?? 0}`
      console.log(
        `${result.success ? 'ok' : 'FAIL'} wall=${result.wallMs}ms ttft=${result.ttftMs ?? '?'}ms rounds=${result.rounds} tools=${tools} citations=${citations}`
      )
      if (result.failureReason) console.log(`        ${result.failureReason}`)
    }
    runs.push(results)
    samples.push(summariseBench(results))
  }

  const aggregate = aggregateBenchRuns(runs)
  const endedAtIso = new Date().toISOString()
  const report: Report = {
    meta: {
      schema: HARNESS_VERSION,
      harness: `lux-bench@${HARNESS_VERSION}`,
      generatedAt: endedAtIso,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      durationMs: Date.now() - bootAt,
      command: BASELINE ? 'bench:baseline' : 'bench',
      baseline: BASELINE,
      verified: BASELINE && git.dirty === false,
      commit: git.commit,
      branch: git.branch,
      dirty: git.dirty,
      diffHash: git.diffHash,
      taskSetHash: taskSetHash(selected),
      runs: RUN_COUNT,
      sampling: SAMPLING,
      model: settings.model,
      modelDigest: modelInfo.digest,
      ollamaUrl: settings.ollamaUrl,
      ollamaVersion: modelInfo.ollamaVersion,
      coldStartMs,
      toolCount: toolDefinitions().length,
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? null,
        cores: cpus().length,
        totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
        node: process.versions.node,
        electron: process.versions.electron
      },
      settings: {
        contextWindow: settings.contextWindow,
        maxOutputTokens: settings.maxOutputTokens,
        modelKeepAlive: settings.modelKeepAlive,
        memoryMode: settings.memoryMode,
        keepModelLoaded: settings.keepModelLoaded
      },
      idleRss: {
        idleRssMb: idle.idleRssMb,
        source: 'docs/benchmarks/idle-rss.json',
        sampleAt: idle.sampleAt,
        stale: idle.stale,
        note:
          'Separate process-tree sample; Ollama is not counted. Use it with its timestamp, not as part of the turn timings.'
      }
    },
    summary: aggregate.summary,
    samples,
    tasks: aggregate.tasks
  }

  const docs = join(repoRoot(), 'docs', 'benchmarks')
  mkdirSync(docs, { recursive: true })
  const rawDir = join(docs, 'raw')
  mkdirSync(rawDir, { recursive: true })
  const baseName = (process.env.LUX_BENCH_OUT?.trim() || (BASELINE ? 'v0.0.1-baseline' : 'latest')).replace(
    /[^a-zA-Z0-9._-]/g,
    ''
  )
  // Replies, tool summaries and cited URLs can contain clipboard text, file
  // paths or page content. Keep them local and ignored; the committed report
  // has only machine-checkable outcomes, counts and measurements.
  writeFileSync(
    join(rawDir, `${baseName}.raw.json`),
    `${JSON.stringify({ meta: report.meta, summary: report.summary, samples, runs }, null, 2)}\n`,
    'utf8'
  )
  const publicTasks = aggregate.tasks.map((task) => ({
    ...task,
    toolCalls: task.toolCalls.map(({ name, status, ms }) => ({ name, status, ms }))
  }))
  const publicReport = { ...report, tasks: publicTasks, ...(idle.idleRssMb !== null ? { idleRssMb: idle.idleRssMb } : {}) }
  const target = join(docs, `${baseName}.json`)
  writeFileSync(target, `${JSON.stringify(publicReport, null, 2)}\n`, 'utf8')
  console.log(`[bench] wrote ${target}`)
  console.log(
    `[bench] stable ${aggregate.summary.successes}/${aggregate.summary.count} · median wall ${fmt(aggregate.summary.medianWallMs)} · trivial ${fmt(aggregate.summary.medianTrivialWallMs)} · research ${fmt(aggregate.summary.medianResearchWallMs)} · multi-tool ${fmt(aggregate.summary.medianMultiToolWallMs)} (${aggregate.summary.multiToolTurns}) · cache ${aggregate.summary.cacheReusePct ?? '?'}% · citation turns ${aggregate.summary.citationTurns}`
  )
  const flaky = aggregate.tasks.filter((task) => task.flaky)
  if (flaky.length > 0) {
    console.log(`[bench] flaky: ${flaky.map((task) => `${task.id} ${task.passes}/${task.runs}`).join(', ')}`)
  }
  if (!BASELINE) {
    console.log('[bench] one run is for iteration only; use npm run bench:baseline for a comparable number')
  }

  engine.stop()
  app.exit(aggregate.summary.failures === 0 ? 0 : 1)
}

async function runTask(
  task: BenchTask,
  settings: ReturnType<typeof getSettings>,
  memory: Memory,
  toolContext: ToolContext,
  tasks: TaskStateStore,
  machine: {
    runningApps: string[]
    battery: Awaited<ReturnType<typeof batteryInfo>>
    volume: number
    frontmostApp: string | undefined
  }
): Promise<BenchTurnResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS[task.category])
  let firstTokenAt: number | undefined
  let outcome: AgentOutcome | undefined
  let errorText: string | undefined
  const taskState = tasks.begin(task.prompt)

  try {
    outcome = await runAgent({
      userText: task.prompt,
      history: [],
      settings,
      memory,
      machine,
      toolContext,
      taskState,
      sampling: SAMPLING,
      timeBudgetMs: AGENT_BUDGET_MS[task.category],
      signal: controller.signal,
      emit: (event: AgentEvent) => {
        if (event.type === 'token' && firstTokenAt === undefined) firstTokenAt = Date.now()
      }
    })
  } catch (error) {
    errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    clearTimeout(timeout)
  }

  const wallMs = Date.now() - started
  const trace = readLastTrace()
  const modelSteps = trace?.steps.filter((step) => step.kind === 'model') ?? []
  const promptTokens = modelSteps.reduce((sum, step) => sum + (step.metrics?.promptEvalCount ?? 0), 0)
  const evalTokens = modelSteps.reduce((sum, step) => sum + (step.metrics?.evalCount ?? 0), 0)
  const cachedPromptTokens = modelSteps.reduce(
    (sum, step) => sum + (step.metrics?.promptEvalCachedCount ?? 0),
    0
  )
  const toolNames = outcome?.toolRuns.filter((run) => run.status === 'ok').map((run) => run.name) ?? []
  const text = outcome?.text ?? ''
  const evidenceUrls = outcome?.evidenceUrls ?? []
  const citations = benchCitationCounts(text, evidenceUrls)
  const failureReason =
    errorText ??
    (outcome
      ? checkBenchTask(task, {
          text,
          toolNames,
          evidenceUrls,
          rounds: modelSteps.length,
          incomplete: outcome.incomplete
        })
      : 'no agent outcome')

  return {
    id: task.id,
    category: task.category,
    prompt: task.prompt,
    wallMs,
    ttftMs: firstTokenAt === undefined ? undefined : firstTokenAt - started,
    // V.0 speaks only after the loop; this is when speech is handed the text.
    ttfswMs: wallMs,
    promptTokens,
    evalTokens,
    cachedPromptTokens,
    cacheReusePct:
      promptTokens > 0 ? Math.round((cachedPromptTokens / promptTokens) * 100) : undefined,
    rounds: modelSteps.length,
    toolRounds: countToolRounds(trace?.steps ?? []),
    toolCalls:
      outcome?.toolRuns.map((run) => ({
        name: run.name,
        status: run.status,
        ms: run.ms,
        summary: run.summary
      })) ?? [],
    success: failureReason === null,
    ...(failureReason ? { failureReason } : {}),
    text: text.slice(0, 4_000),
    replyChars: text.length,
    citedUrls: citations.cited,
    citationsBacked: citations.backed,
    citationsUnbacked: citations.unbacked
  }
}

function countToolRounds(steps: TraceStep[]): number {
  let count = 0
  let roundHasTool = false
  for (const step of steps) {
    if (step.kind === 'round') {
      if (roundHasTool) count += 1
      roundHasTool = false
    } else if (step.kind === 'tool') {
      roundHasTool = true
    }
  }
  return roundHasTool ? count + 1 : count
}

function readLastTrace(): TraceRecord | null {
  const file = join(benchRoot, 'logs', 'turns.jsonl')
  if (!existsSync(file)) return null
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const last = lines[lines.length - 1]
    return last ? (JSON.parse(last) as TraceRecord) : null
  } catch {
    return null
  }
}

function selectTasks(): BenchTask[] {
  const only = process.env.LUX_BENCH_ONLY?.split(',').map((id) => id.trim()).filter(Boolean)
  return only && only.length > 0 ? BENCH_TASKS.filter((task) => only.includes(task.id)) : BENCH_TASKS
}

async function unloadModel(url: string, model: string): Promise<void> {
  try {
    await fetch(`${url.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    // Ollama may not be running yet; the supervisor will start it.
  }
}

async function readModelInfo(url: string, model: string): Promise<ModelInfo> {
  const base = url.replace(/\/$/, '')
  const [tags, version] = await Promise.all([
    getJson(`${base}/api/tags`),
    getJson(`${base}/api/version`)
  ])
  const models = (tags as { models?: { name?: string; digest?: string }[] } | null)?.models ?? []
  const normalise = (name: string): string => name.replace(/:latest$/, '')
  const match = models.find((entry) => entry.name && normalise(entry.name) === normalise(model))
  const versionValue = (version as { version?: string } | null)?.version
  return {
    digest: match?.digest ?? null,
    ollamaVersion: typeof versionValue === 'string' ? versionValue : null
  }
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** Provenance of the code that produced the numbers, not the code at commit time. */
function gitInfo(): GitInfo {
  const cwd = repoRoot()
  try {
    const run = (args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const status = run(['status', '--porcelain'])
    const diff = execFileSync('git', ['diff', 'HEAD', '--binary'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return {
      commit: run(['rev-parse', '--short', 'HEAD']),
      branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: status.length > 0,
      diffHash: sha256(`${diff}\n-- untracked --\n${untracked}`)
    }
  } catch {
    return { commit: null, branch: null, dirty: null, diffHash: null }
  }
}

function taskSetHash(tasks: BenchTask[]): string {
  const serial = tasks.map(({ replyPattern, ...rest }) => ({
    ...rest,
    replyPattern: replyPattern ? replyPattern.source : null
  }))
  return sha256(JSON.stringify(serial))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

interface IdleRssRead {
  idleRssMb: number | null
  sampleAt: string | null
  stale: boolean
}

function readIdleRss(): IdleRssRead {
  const file = join(repoRoot(), 'docs', 'benchmarks', 'idle-rss.json')
  if (!existsSync(file)) return { idleRssMb: null, sampleAt: null, stale: true }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as IdleRssSample
    const value = typeof record.idleRssMb === 'number' ? record.idleRssMb : null
    const at = typeof record.at === 'string' ? record.at : null
    const parsed = at ? Date.parse(at) : NaN
    const stale = !Number.isFinite(parsed) || Date.now() - parsed > 14 * 24 * 60 * 60 * 1_000
    return { idleRssMb: value, sampleAt: at, stale }
  } catch {
    return { idleRssMb: null, sampleAt: null, stale: true }
  }
}

function repoRoot(): string {
  // `app.getAppPath()` is the directory of the built main file (out/main), not
  // the project. The npm script's INIT_CWD is the project root, and a direct
  // `electron out/main/bench.js` is run from there too.
  return (
    process.env.LUX_REPO_ROOT?.trim() ||
    process.env.INIT_CWD?.trim() ||
    process.cwd()
  )
}

function fmt(value: number | undefined): string {
  return value === undefined ? '?' : `${Math.round(value)}ms`
}

void main().catch((error) => {
  console.error('[bench] failed', error)
  app.exit(1)
})
