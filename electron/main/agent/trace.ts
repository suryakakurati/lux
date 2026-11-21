import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ModelMetrics } from './ollama'

/**
 * A durable record of one turn, for debugging the assistant rather than guessing.
 *
 * Logs answer "what ran"; a trace answers "why did this turn end like that":
 * which tools were offered, what each call returned in one line, how long each
 * round took, whether a nudge fired, and whether the turn ran out of budget.
 * One JSON object per line, capped and rotated, all local.
 */

interface TraceStep {
  at: number
  kind: 'round' | 'model' | 'tool' | 'nudge' | 'stop'
  name?: string
  status?: string
  ms?: number
  summary?: string
  detail?: string
  metrics?: RoundMetrics
}

export interface RoundMetrics extends ModelMetrics {
  promptChars: number
  cacheReusePct?: number
}

export interface TraceInput {
  objective: string
  model: string
  offered: string[]
  /** One line: plan source, playbook and step count. */
  plan?: string
}

export interface TraceOutcome {
  text: string
  nudges: number
  incomplete: boolean
  rounds: number
  tools: { name: string; status: string; ms?: number; summary?: string }[]
}

const MAX_BYTES = 2_000_000

function traceFile(): string {
  return join(app.getPath('userData'), 'logs', 'turns.jsonl')
}

function rotate(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    /* rotation is housekeeping */
  }
}

export class TurnTrace {
  private readonly startedAt = Date.now()
  private readonly steps: TraceStep[] = []

  constructor(private readonly input: TraceInput) {}

  round(index: number): void {
    this.steps.push({ at: Date.now() - this.startedAt, kind: 'round', name: `round ${index}` })
  }

  model(index: number, wallMs: number, metrics: RoundMetrics): void {
    this.steps.push({
      at: Date.now() - this.startedAt,
      kind: 'model',
      name: `model ${index}`,
      ms: wallMs,
      metrics
    })
  }

  tool(name: string, status: string, ms: number | undefined, summary: string | undefined, args: unknown): void {
    let detail: string | undefined
    try {
      detail = JSON.stringify(args).slice(0, 240)
    } catch {
      detail = undefined
    }
    this.steps.push({ at: Date.now() - this.startedAt, kind: 'tool', name, status, ms, summary, detail })
  }

  nudge(reason: string): void {
    this.steps.push({ at: Date.now() - this.startedAt, kind: 'nudge', detail: reason })
  }

  stop(reason: string): void {
    this.steps.push({ at: Date.now() - this.startedAt, kind: 'stop', detail: reason })
  }

  finish(outcome: TraceOutcome): void {
    const record = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      objective: this.input.objective.slice(0, 300),
      model: this.input.model,
      offered: this.input.offered,
      plan: this.input.plan ?? null,
      nudges: outcome.nudges,
      incomplete: outcome.incomplete,
      rounds: outcome.rounds,
      modelMs: this.steps.filter((step) => step.kind === 'model').reduce((sum, step) => sum + (step.ms ?? 0), 0),
      tools: outcome.tools,
      reply: outcome.text.slice(0, 400),
      steps: this.steps
    }
    try {
      const file = traceFile()
      mkdirSync(dirname(file), { recursive: true })
      rotate(file)
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      /* tracing must never break a turn */
    }
  }
}
