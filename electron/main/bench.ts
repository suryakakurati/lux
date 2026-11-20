/**
 * Reproducible benchmark harness for the local agent.
 *
 *   npm run bench
 *
 * It uses the same `runAgent`, tool registry, prompt and Ollama client as the
 * app. Every task runs with an isolated data directory, a fresh task state, a
 * temp memory file and a tool context that denies every confirmation. Nothing
 * in the fixed task set plays audio, opens an app or writes to the real data.
 *
 * Metrics come from the existing turn trace, not from estimates:
 *   - wall time and TTFT are measured in this process
 *   - prompt/eval tokens and cache reuse are read from Ollama's final chunk
 *   - rounds and tool calls come from the trace and AgentOutcome
 *
 * V.0 hands the complete answer to `say` after the loop, so its TTFSW is the
 * turn's wall time. Phase 2 changes that to the first sentence and measures the
 * same field again.
 */
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { BenchSummary, BenchTask, BenchTurnResult } from '../../shared/bench'
import { checkBenchTask, summariseBench } from '../../shared/bench'
import type { AgentEvent, AgentOutcome } from './agent/agent'
import { runAgent } from './agent/agent'
import { EngineSupervisor } from './agent/engine'
import { Memory } from './agent/memory'
import { TaskStateStore } from './agent/task-state'
import { CommitmentLedger } from './commitments'
import { dataDir, getSettings } from './config'
import { initLog } from './log'
import { batteryInfo, frontmostApp, outputVolume, runningApps } from './mac/stats'
import { toolDefinitions } from './tools'
import type { ToolContext } from './tools/types'
import { BENCH_TASKS } from './bench-tasks'

const bootAt = Date.now()
const benchRoot = mkdtempSync(join(tmpdir(), 'lux-bench-'))
const benchData = join(benchRoot, 'data')
mkdirSync(benchData, { recursive: true })
// config.dataDir honours this, so settings, tasks, commitments and memory all
// live in the temp directory. Logs and traces follow userData below.
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

interface Report {
  meta: {
    generatedAt: string
    commit: string | null
    model: string
    ollamaUrl: string
    coldStartMs: number
    toolCount: number
    machine: {
      platform: string
      arch: string
      cpu: string | null
      cores: number
      totalMemGb: number
    }
    settings: {
      contextWindow: number
      maxOutputTokens: number
      modelKeepAlive: string
      memoryMode: string
      keepModelLoaded: boolean
    }
  }
  summary: BenchSummary
  tasks: BenchTurnResult[]
  idleRssMb?: number | null
}

async function main(): Promise<void> {
  await app.whenReady()
  initLog()

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
  const tasks = new TaskStateStore(dataDir())
  const toolContext: ToolContext = {
    settings,
    commitments,
    confirm: async () => false,
    notify: () => undefined,
    speak: () => undefined,
    remember: () => undefined
  }

  const selected = selectTasks()
  const results: BenchTurnResult[] = []
  console.log(`[bench] model=${settings.model} tasks=${selected.length} coldStart=${coldStartMs}ms`)

  for (let index = 0; index < selected.length; index += 1) {
    const task = selected[index]
    process.stdout.write(`[bench] ${String(index + 1).padStart(2, '0')}/${selected.length} ${task.id} … `)
    const result = await runTask(task, settings, memory, toolContext, tasks, machine)
    results.push(result)
    const tools = result.toolCalls.map((call) => call.name).join(',') || 'none'
    console.log(
      `${result.success ? 'ok' : 'FAIL'} wall=${result.wallMs}ms ttft=${result.ttftMs ?? '?'}ms rounds=${result.rounds} tools=${tools}`
    )
    if (result.failureReason) console.log(`        ${result.failureReason}`)
  }

  const summary = summariseBench(results)
  const report: Report = {
    meta: {
      generatedAt: new Date().toISOString(),
      commit: gitCommit(),
      model: settings.model,
      ollamaUrl: settings.ollamaUrl,
      coldStartMs,
      toolCount: toolDefinitions().length,
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? null,
        cores: cpus().length,
        totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10
      },
      settings: {
        contextWindow: settings.contextWindow,
        maxOutputTokens: settings.maxOutputTokens,
        modelKeepAlive: settings.modelKeepAlive,
        memoryMode: settings.memoryMode,
        keepModelLoaded: settings.keepModelLoaded
      }
    },
    summary,
    tasks: results,
    idleRssMb: readIdleRss()
  }

  const docs = join(repoRoot(), 'docs', 'benchmarks')
  mkdirSync(docs, { recursive: true })
  const rawDir = join(docs, 'raw')
  mkdirSync(rawDir, { recursive: true })
  // Replies and tool summaries can contain clipboard text, file paths or page
  // content. Keep them local and ignored; the committed report has only the
  // machine-checkable outcome and measurements.
  writeFileSync(
    join(rawDir, 'v0.0-baseline.raw.json'),
    `${JSON.stringify({ meta: report.meta, summary, tasks: results }, null, 2)}\n`,
    'utf8'
  )
  const publicTasks = results.map((result) => ({
    ...result,
    text: '',
    replyChars: result.text.length,
    toolCalls: result.toolCalls.map(({ name, status, ms }) => ({ name, status, ms }))
  }))
  const publicReport = { ...report, tasks: publicTasks }
  const target = join(docs, 'v0.0-baseline.json')
  writeFileSync(target, `${JSON.stringify(publicReport, null, 2)}\n`, 'utf8')
  console.log(`[bench] wrote ${target}`)
  console.log(
    `[bench] ${summary.successes}/${summary.count} passed · median wall ${fmt(summary.medianWallMs)} · median TTFT ${fmt(summary.medianTtftMs)} · multi-tool median ${fmt(summary.medianMultiToolWallMs)} (${summary.multiToolTurns} turns) · cache ${summary.cacheReusePct ?? '?'}%`
  )

  engine.stop()
  app.exit(summary.failures === 0 ? 0 : 1)
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
  const timeout = setTimeout(() => controller.abort(), 360_000)
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
  const failureReason =
    errorText ??
    (outcome
      ? checkBenchTask(task, {
          text,
          toolNames,
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
    replyChars: text.length
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

function gitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot(),
      encoding: 'utf8'
    }).trim()
  } catch {
    return null
  }
}

function repoRoot(): string {
  return process.env.INIT_CWD?.trim() || process.cwd()
}

function readIdleRss(): number | null {
  const file = join(repoRoot(), 'docs', 'benchmarks', 'idle-rss.json')
  if (!existsSync(file)) return null
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { idleRssMb?: number }
    return typeof record.idleRssMb === 'number' ? record.idleRssMb : null
  } catch {
    return null
  }
}

function fmt(value: number | undefined): string {
  return value === undefined ? '?' : `${Math.round(value)}ms`
}

void main().catch((error) => {
  console.error('[bench] failed', error)
  app.exit(1)
})
