/**
 * Pure benchmark definitions and checks.
 *
 * The harness itself needs a model, a Mac and several minutes. Everything in
 * this file is deliberately model-free so task success rules and summary
 * statistics can be unit tested.
 */

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
}

export interface BenchCheckInput {
  text: string
  /** Names of calls that completed successfully. */
  toolNames: string[]
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
  /** When the full reply was handed to speech in V.0. */
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
  promptTokens: number
  evalTokens: number
  cachedPromptTokens: number
  cacheReusePct?: number
  medianRounds?: number
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
    promptTokens,
    evalTokens,
    cachedPromptTokens,
    cacheReusePct:
      promptTokens > 0 ? Math.round((cachedPromptTokens / promptTokens) * 100) : undefined,
    medianRounds: median(results.map((result) => result.rounds))
  }
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
  if (task.replyPattern && !task.replyPattern.test(input.text)) {
    return `reply did not match ${task.replyPattern}`
  }
  return null
}
