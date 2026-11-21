/**
 * Pure benchmark definitions and checks.
 *
 * The harness itself needs a model, a Mac and several minutes. Everything in
 * this file is deliberately model-free so task success rules, citation checks
 * and summary statistics can be unit tested.
 */

import { citationFailure, citationStats } from './citations.ts'

export type BenchCategory = 'trivial' | 'one-tool' | 'multi-tool' | 'research' | 'ambiguous'

export interface BenchTask {
  id: string
  category: BenchCategory
  prompt: string
  /** Every one of these tools must have completed successfully. */
  expectedToolsAll?: string[]
  /** At least one of these tools must have completed successfully. */
  expectedToolsAny?: string[]
  /** Any of these completed calls fails the task, even if the answer is right. */
  forbiddenTools?: string[]
  /** The reply must match this pattern. */
  replyPattern?: RegExp
  replyMinChars?: number
  replyMaxChars?: number
  /** Hard ceiling on completed tool calls. */
  maxTools?: number
  /** Hard ceiling on model rounds (tool calls plus the final answer). */
  maxRounds?: number
  /** The answer must contain a question mark: a targeted clarifying question. */
  expectQuestion?: boolean
  /**
   * An ambiguous task may be resolved by one useful read OR by asking one
   * targeted question. Asking is not a failure when the request is genuinely
   * underdetermined.
   */
  allowQuestionInsteadOfTools?: boolean
  /** Distinct source URLs the answer must cite. */
  requiredCitations?: number
  /** Distinct hosts among the cited sources. */
  requiredCitationHosts?: number
  /** Defaults to true: every cited URL must have appeared in tool output. */
  citationsFromEvidence?: boolean
}

export interface BenchCheckInput {
  text: string
  /** Names of calls that completed successfully. */
  toolNames: string[]
  /** Every URL returned by this turn's tools. */
  evidenceUrls?: string[]
  rounds: number
  incomplete: boolean
}

export interface BenchToolCall {
  name: string
  status: string
  ms?: number
  summary?: string
}

export interface BenchTurnResult {
  id: string
  category: BenchCategory
  prompt: string
  wallMs: number
  /** First non-thinking content token. */
  ttftMs?: number
  /** When the full reply was handed to speech. */
  ttfswMs: number
  promptTokens: number
  evalTokens: number
  cachedPromptTokens: number
  cacheReusePct?: number
  rounds: number
  toolRounds: number
  toolCalls: BenchToolCall[]
  success: boolean
  failureReason?: string
  /** Kept in memory for checks; the committed report redacts it. */
  text: string
  replyChars: number
  /** Normalised URLs cited in the reply. Raw only. */
  citedUrls?: string[]
  /** Cited URLs that also appeared in tool output. */
  citationsBacked?: number
  /** Cited URLs that were never seen in tool output. */
  citationsUnbacked?: number
}

export interface BenchSummary {
  count: number
  successes: number
  failures: number
  medianWallMs?: number
  medianTtftMs?: number
  medianTtfswMs?: number
  medianMultiToolWallMs?: number
  medianMultiToolTtftMs?: number
  multiToolTurns: number
  medianTrivialWallMs?: number
  medianOneToolWallMs?: number
  medianResearchWallMs?: number
  promptTokens: number
  evalTokens: number
  cachedPromptTokens: number
  cacheReusePct?: number
  medianRounds?: number
  citationTurns: number
}

/** One task measured across repeated runs. */
export interface BenchTaskAggregate {
  id: string
  category: BenchCategory
  prompt: string
  runs: number
  passes: number
  passRate: number
  /** True only when every run passed. A flaky task is not a stable success. */
  success: boolean
  flaky: boolean
  failureReasons: string[]
  wallMs: number
  ttftMs?: number
  ttfswMs: number
  promptTokens: number
  evalTokens: number
  cachedPromptTokens: number
  cacheReusePct?: number
  rounds: number
  toolRounds: number
  toolCalls: BenchToolCall[]
  citationsBacked: number
  citationsUnbacked: number
  replyChars: number
}

export interface BenchAggregate {
  runs: number
  summary: BenchSummary
  tasks: BenchTaskAggregate[]
}

export function median(values: number[]): number | undefined {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return undefined
  const middle = Math.floor(clean.length / 2)
  if (clean.length % 2 === 1) return clean[middle]
  return (clean[middle - 1] + clean[middle]) / 2
}

export function summariseBench(results: BenchTurnResult[]): BenchSummary {
  const successes = results.filter((result) => result.success).length
  const multi = results.filter((result) => result.toolCalls.length >= 2)
  const promptTokens = results.reduce((sum, result) => sum + result.promptTokens, 0)
  const evalTokens = results.reduce((sum, result) => sum + result.evalTokens, 0)
  const cachedPromptTokens = results.reduce((sum, result) => sum + result.cachedPromptTokens, 0)
  const wallFor = (category: BenchCategory): number | undefined =>
    median(results.filter((result) => result.category === category).map((result) => result.wallMs))
  return {
    count: results.length,
    successes,
    failures: results.length - successes,
    medianWallMs: median(results.map((result) => result.wallMs)),
    medianTtftMs: median(results.map((result) => result.ttftMs ?? NaN)),
    medianTtfswMs: median(results.map((result) => result.ttfswMs)),
    medianMultiToolWallMs: median(multi.map((result) => result.wallMs)),
    medianMultiToolTtftMs: median(multi.map((result) => result.ttftMs ?? NaN)),
    multiToolTurns: multi.length,
    medianTrivialWallMs: wallFor('trivial'),
    medianOneToolWallMs: wallFor('one-tool'),
    medianResearchWallMs: wallFor('research'),
    promptTokens,
    evalTokens,
    cachedPromptTokens,
    cacheReusePct:
      promptTokens > 0 ? Math.round((cachedPromptTokens / promptTokens) * 100) : undefined,
    medianRounds: median(results.map((result) => result.rounds)),
    citationTurns: results.filter((result) => (result.citationsBacked ?? 0) > 0).length
  }
}

/**
 * Repeated runs, reduced to one comparable row per task.
 *
 * A task counts as a success only when every run passed. Wall time and tokens
 * are the median of the runs, so one slow outlier cannot define the baseline.
 */
export function aggregateBenchRuns(runs: BenchTurnResult[][]): BenchAggregate {
  const byId = new Map<string, BenchTurnResult[]>()
  for (const run of runs) {
    for (const result of run) {
      const list = byId.get(result.id) ?? []
      list.push(result)
      byId.set(result.id, list)
    }
  }

  const tasks: BenchTaskAggregate[] = []
  for (const [id, list] of byId) {
    const first = list[0]
    const passes = list.filter((result) => result.success).length
    const failures = list.filter((result) => !result.success && result.failureReason)
    const wallMs = median(list.map((result) => result.wallMs)) ?? first.wallMs
    const ttft = median(list.map((result) => result.ttftMs ?? NaN))
    tasks.push({
      id,
      category: first.category,
      prompt: first.prompt,
      runs: list.length,
      passes,
      passRate: Math.round((passes / list.length) * 100),
      success: passes === list.length,
      flaky: passes > 0 && passes < list.length,
      failureReasons: [...new Set(failures.map((result) => result.failureReason as string))],
      wallMs,
      ...(ttft === undefined ? {} : { ttftMs: ttft }),
      ttfswMs: median(list.map((result) => result.ttfswMs)) ?? wallMs,
      promptTokens: median(list.map((result) => result.promptTokens)) ?? 0,
      evalTokens: median(list.map((result) => result.evalTokens)) ?? 0,
      cachedPromptTokens: median(list.map((result) => result.cachedPromptTokens)) ?? 0,
      cacheReusePct: median(list.map((result) => result.cacheReusePct ?? NaN)),
      rounds: median(list.map((result) => result.rounds)) ?? first.rounds,
      toolRounds: median(list.map((result) => result.toolRounds)) ?? first.toolRounds,
      toolCalls: first.toolCalls,
      citationsBacked: median(list.map((result) => result.citationsBacked ?? 0)) ?? 0,
      citationsUnbacked: median(list.map((result) => result.citationsUnbacked ?? 0)) ?? 0,
      replyChars: Math.round(median(list.map((result) => result.replyChars)) ?? first.replyChars)
    })
  }
  tasks.sort((a, b) => runs[0].findIndex((result) => result.id === a.id) - runs[0].findIndex((result) => result.id === b.id))

  const asTurns: BenchTurnResult[] = tasks.map((task) => ({
    id: task.id,
    category: task.category,
    prompt: task.prompt,
    wallMs: task.wallMs,
    ...(task.ttftMs === undefined ? {} : { ttftMs: task.ttftMs }),
    ttfswMs: task.ttfswMs,
    promptTokens: task.promptTokens,
    evalTokens: task.evalTokens,
    cachedPromptTokens: task.cachedPromptTokens,
    ...(task.cacheReusePct === undefined ? {} : { cacheReusePct: task.cacheReusePct }),
    rounds: task.rounds,
    toolRounds: task.toolRounds,
    toolCalls: task.toolCalls,
    success: task.success,
    text: '',
    replyChars: task.replyChars,
    citationsBacked: task.citationsBacked,
    citationsUnbacked: task.citationsUnbacked
  }))

  return { runs: runs.length, summary: summariseBench(asTurns), tasks }
}

/** Returns null when the task passed, or a short reason when it did not. */
export function checkBenchTask(task: BenchTask, input: BenchCheckInput): string | null {
  if (input.incomplete) return 'turn ended incomplete'
  if (task.maxTools !== undefined && input.toolNames.length > task.maxTools) {
    return `used ${input.toolNames.length} tools, limit ${task.maxTools}`
  }
  if (task.maxRounds !== undefined && input.rounds > task.maxRounds) {
    return `used ${input.rounds} rounds, limit ${task.maxRounds}`
  }
  for (const name of task.forbiddenTools ?? []) {
    if (input.toolNames.includes(name)) return `forbidden tool ran: ${name}`
  }
  if (task.expectedToolsAll) {
    const missing = task.expectedToolsAll.filter((name) => !input.toolNames.includes(name))
    if (missing.length > 0) return `missing tools: ${missing.join(', ')}`
  }
  if (task.expectedToolsAny && task.expectedToolsAny.length > 0) {
    const found = task.expectedToolsAny.some((name) => input.toolNames.includes(name))
    const asked = task.allowQuestionInsteadOfTools === true && /\?/.test(input.text)
    if (!found && !asked) return `missing any of: ${task.expectedToolsAny.join(', ')}`
  }
  if (task.expectQuestion && !/\?/.test(input.text)) return 'expected a targeted question'
  if (task.replyMinChars !== undefined && input.text.trim().length < task.replyMinChars) {
    return `reply shorter than ${task.replyMinChars} characters`
  }
  if (task.replyMaxChars !== undefined && input.text.trim().length > task.replyMaxChars) {
    return `reply longer than ${task.replyMaxChars} characters`
  }
  if (task.requiredCitations !== undefined && task.requiredCitations > 0) {
    const citationProblem = citationFailure(input.text, input.evidenceUrls ?? [], {
      citations: task.requiredCitations,
      hosts: task.requiredCitationHosts,
      fromEvidence: task.citationsFromEvidence !== false
    })
    if (citationProblem) return citationProblem
  }
  if (task.replyPattern && !task.replyPattern.test(input.text)) {
    return `reply did not match ${task.replyPattern}`
  }
  return null
}

/** Citation counts for the report, derived from the same rules as the check. */
export function benchCitationCounts(
  text: string,
  evidenceUrls: string[]
): { backed: number; unbacked: number; cited: string[] } {
  const stats = citationStats(text, evidenceUrls)
  return { backed: stats.backed, unbacked: stats.unbacked, cited: stats.cited }
}
