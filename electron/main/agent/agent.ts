import type { Settings, ToolRun } from '../../../shared/types'
import { mapLimit } from '../../../shared/concurrency'
import type { Memory } from './memory'
import type { ModelManager } from './model-manager'
import type { ModelMetrics, OllamaMessage } from './ollama'
import { streamChat } from './ollama'
import { cacheReusePercent } from '../../../shared/metrics'
import { nudgeFor, stallReason } from '../../../shared/completion'
import { buildSystemPrompt, type PromptContext } from './prompt'
import { shortlistTools } from '../../../shared/tool-router'
import { logLine } from '../log'
import { executeTool, findTool, toolDefinitions } from '../tools'
import type { ToolCallOutcome, ToolContext } from '../tools/types'
import type { TaskState } from './task-state'
import { needsMusicTaste, needsSiteCheck } from './refusals'
import { ToolCallAccumulator, type ResolvedCall } from './accumulator'
import { repeatDecision, repeatMessage, type Attempt, type RepeatDecision } from './tool-policy'
import { TurnTrace } from './trace'

export type AgentPhase = 'planning' | 'researching' | 'reading' | 'verifying' | 'acting'

export type AgentEvent =
  | { type: 'token'; delta: string }
  // Replaces everything streamed so far, after a turn is nudged to keep going.
  | { type: 'replace'; text: string }
  | { type: 'tool-start'; run: ToolRun }
  | { type: 'tool-end'; run: ToolRun }
  /** A meaningful phase change, distinct from a generic spinner. */
  | { type: 'phase'; phase: AgentPhase; detail?: string }
  /** Round-level heartbeat so a slow turn never looks frozen. */
  | { type: 'progress'; step: number; elapsedMs: number; label: string }
  | { type: 'notice'; text: string }

export interface AgentInput {
  userText: string
  history: OllamaMessage[]
  settings: Settings
  memory: Memory
  models?: ModelManager
  machine: Omit<PromptContext, 'now' | 'facts' | 'recall' | 'tools' | 'settings' | 'objective' | 'openTask' | 'taskState'>
  toolContext: ToolContext
  signal?: AbortSignal
  /** One line injected for this turn only, e.g. "browse before answering". */
  turnHint?: string
  /** Work carried over from the previous turn because it ran out of budget. */
  openTask?: string
  /** Structured task record, persisted outside the model context. */
  taskState?: TaskState
  emit: (event: AgentEvent) => void
}

export interface AgentOutcome {
  text: string
  hadTools: boolean
  toolRuns: ToolRun[]
  forcedChat: boolean
  /** True when the turn stopped on its budget with the job unfinished. */
  incomplete: boolean
  objective: string
}

const MAX_TOOL_ROUNDS = 16
/** A turn may chain many steps, but not forever: the person is waiting. */
const TIME_BUDGET_MS = 240_000
const MAX_NUDGES = 2
const MAX_PARALLEL_TOOLS = 3

interface PreparedCall {
  call: ResolvedCall
  run: ToolRun
  signature: string
  previous: Attempt[]
  decision: RepeatDecision
}

/**
 * The reasoning loop: stream a reply, execute any tools it asks for, feed the
 * results back, and repeat until the model answers without a tool call.
 *
 * Three things make this feel like an assistant rather than a chat window:
 *
 *  - The loop owns the objective. A reply that announces the next step or asks
 *    permission to take it is not an answer, so the turn continues.
 *  - The stalled draft is never appended to the transcript. A small model shown
 *    its own deferral writes it again almost word for word.
 *  - Only the plausible tools are offered, which is both faster and a sharper
 *    choice for a small model. Dynamic discovery and unlisted execution keep
 *    the shortlist from becoming a permission boundary.
 *
 * Independent read-only calls in one round run with a small concurrency cap.
 * Dependent calls, confirmations and browser actions stay sequential.
 */
export async function runAgent(input: AgentInput): Promise<AgentOutcome> {
  const allTools = toolDefinitions()
  const objective = input.userText.trim()
  const actionable = needsSiteCheck(objective) || needsMusicTaste(objective) || Boolean(input.openTask)
  const tools = shortlistTools(`${objective} ${input.turnHint ?? ''} ${input.openTask ?? ''}`, allTools)
  const task = input.taskState

  input.emit({
    type: 'phase',
    phase: 'planning',
    detail: actionable ? 'Working out the approach.' : 'Understanding the request.'
  })

  const [recall] = await Promise.all([
    input.memory.recall(objective),
    input.models?.prepare(input.settings.model)
  ])
  const facts = input.memory.facts()
  const system = buildSystemPrompt({
    now: new Date(),
    frontmostApp: input.machine.frontmostApp,
    runningApps: input.machine.runningApps,
    battery: input.machine.battery,
    volume: input.machine.volume,
    facts,
    recall,
    tools,
    settings: input.settings,
    turnHint: input.turnHint,
    objective,
    openTask: input.openTask,
    taskState: task?.prompt()
  })

  const messages: OllamaMessage[] = [
    { role: 'system', content: system },
    ...input.history,
    { role: 'user', content: objective }
  ]

  const toolRuns: ToolRun[] = []
  const attempts = new Map<string, Attempt[]>()
  const trace = new TurnTrace({
    objective,
    model: input.settings.model,
    offered: tools.map((tool) => tool.function.name)
  })
  const startedAt = Date.now()
  let nudges = 0
  let lastToolName = ''
  let lastSummary = ''
  let finalText = ''
  let hadTools = false
  let forcedChat = false
  let incomplete = false
  let rounds = 0

  logLine(
    'agent',
    `objective=${JSON.stringify(objective.slice(0, 160))} tools=${tools.length}/${allTools.length} promptChars=${system.length}${input.openTask ? ' resumed=true' : ''}`
  )

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      throwIfAborted(input.signal)
      rounds = round

      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        incomplete = true
        finalText =
          finalText ||
          `I'm still working through this${lastSummary ? ` (last: ${lastSummary})` : ''}. Say continue and I'll pick it up from there.`
        trace.stop('time budget')
        break
      }

      if (round > 0) {
        input.emit({
          type: 'progress',
          step: round,
          elapsedMs: Date.now() - startedAt,
          label: lastSummary || lastToolName || 'thinking'
        })
      }
      trace.round(round)

      const modelOptions = input.models?.chatOptions() ?? {
        keepAlive: input.settings.keepModelLoaded ? input.settings.modelKeepAlive || '30m' : '0',
        numCtx: input.settings.contextWindow || 8_192,
        numPredict: input.settings.maxOutputTokens || 1_536
      }
      const modelStartedAt = Date.now()
      const stream = await streamChat({
        url: input.settings.ollamaUrl,
        model: input.settings.model,
        messages,
        tools,
        keepAlive: modelOptions.keepAlive,
        numCtx: modelOptions.numCtx,
        numPredict: modelOptions.numPredict,
        signal: input.signal
      })

      let roundText = ''
      let roundMetrics: ModelMetrics | undefined
      const accumulator = new ToolCallAccumulator()
      for await (const chunk of stream) {
        if (chunk.metrics) roundMetrics = chunk.metrics
        if (chunk.thinking) continue
        if (chunk.content) {
          roundText += chunk.content
          input.emit({ type: 'token', delta: chunk.content })
        }
        if (chunk.toolCalls) accumulator.add(chunk.toolCalls)
      }

      const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0)
      const cacheReusePct = cacheReusePercent(
        roundMetrics?.promptEvalCachedCount,
        roundMetrics?.promptEvalCount
      )
      const wallMs = Date.now() - modelStartedAt
      trace.model(round, wallMs, {
        ...roundMetrics,
        promptChars,
        cacheReusePct
      })
      logLine(
        'model',
        `round=${round} wallMs=${wallMs} promptChars=${promptChars} promptEval=${roundMetrics?.promptEvalCount ?? '?'} promptCached=${roundMetrics?.promptEvalCachedCount ?? '?'} eval=${roundMetrics?.evalCount ?? '?'} promptEvalMs=${roundMetrics?.promptEvalDurationMs ?? '?'} evalMs=${roundMetrics?.evalDurationMs ?? '?'} loadMs=${roundMetrics?.loadDurationMs ?? '?'} cacheReuse=${cacheReusePct ?? '?'}%`
      )

      const calls = accumulator.finish()
      if (calls.length === 0) {
        const reply = roundText.trim()
        const stall = stallReason(reply, { usedTools: hadTools, actionable })

        if (stall && nudges < MAX_NUDGES && round < MAX_TOOL_ROUNDS) {
          nudges += 1
          trace.nudge(stall)
          task?.note(`model stalled (${stall}); nudging it to continue`)
          logLine(
            'agent',
            `stalled (${stall}) after ${Date.now() - startedAt}ms, continuing: ${JSON.stringify(reply.slice(0, 140))}`
          )
          // The draft is deliberately not appended: reading its own deferral makes
          // a small model repeat it. Only the directive goes back.
          messages.push({ role: 'user', content: nudgeFor(stall, objective) })
          // Clear what was already streamed, or the next draft lands underneath it
          // and the person watches two answers grow into each other.
          input.emit({ type: 'replace', text: '' })
          continue
        }

        if (hadTools) {
          input.emit({ type: 'phase', phase: 'verifying', detail: 'Checking the result.' })
        }
        finalText = reply
        if (nudges > 0) input.emit({ type: 'replace', text: reply })
        break
      }

      hadTools = true
      messages.push({ role: 'assistant', content: roundText, tool_calls: accumulator.raw() })

      const prepared: PreparedCall[] = calls.map((call) => {
        const run: ToolRun = {
          id: `tool-${Date.now()}-${toolRuns.length}-${Math.random().toString(36).slice(2, 6)}`,
          name: call.name,
          args: call.args,
          status: 'running'
        }
        toolRuns.push(run)
        const signature = `${call.name}:${JSON.stringify(call.args)}`
        const previous = attempts.get(signature) ?? []
        const nameCount = (attempts.get(`#${call.name}`) ?? []).length + 1
        const searchingTooMuch =
          (call.name === 'history_search' && nameCount > 2) ||
          (call.name === 'web_search' && nameCount > 3) ||
          (call.name === 'research' && nameCount > 2)
        const decision: RepeatDecision = searchingTooMuch ? 'block' : repeatDecision(previous)
        if (!tools.some((tool) => tool.function.name === call.name)) {
          logLine('agent', `unlisted tool called: ${call.name} (executed anyway)`)
        }
        return { call, run, signature, previous, decision }
      })

      for (const item of prepared) input.emit({ type: 'tool-start', run: item.run })

      const outcomes = await executeRound(prepared, attempts, input, trace)

      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index]
        const outcome = outcomes[index]
        lastToolName = item.call.name
        const finished: ToolRun = {
          ...item.run,
          status: outcome.ok ? 'ok' : outcome.denied ? 'denied' : 'error',
          summary: outcome.summary,
          ms: outcome.durationMs
        }
        const runIndex = toolRuns.findIndex((run) => run.id === finished.id)
        if (runIndex >= 0) toolRuns[runIndex] = finished
        lastSummary = finished.summary ?? finished.name
        trace.tool(item.call.name, finished.status, finished.ms, finished.summary, item.call.args)
        input.emit({ type: 'tool-end', run: finished })

        if (outcome.openChat) forcedChat = true
        messages.push({ role: 'tool', tool_name: item.call.name, content: outcome.content })
        task?.tool(item.call.name, outcome.ok, outcome.summary, outcome.content, item.call.args)
      }

      // Re-state the compact task state after a batch. This is deliberately
      // small: it keeps the plan, URLs and failures available without replaying
      // every page into the context window.
      if (task) messages.push({ role: 'system', content: task.prompt(true) })

      if (round === MAX_TOOL_ROUNDS) {
        incomplete = true
        finalText = `I used this turn's steps before finishing${lastSummary ? ` (last: ${lastSummary})` : ''}. Say continue and I'll pick it up from there.`
        trace.stop('tool round limit')
      }
    }
  } catch (error) {
    if (task) task.interrupt(error instanceof Error ? error.name : 'error')
    throw error
  }

  if (!finalText && toolRuns.length > 0) {
    const last = toolRuns[toolRuns.length - 1]
    finalText = last?.status === 'ok' ? last.summary ?? 'Done.' : `That didn't work: ${last?.summary ?? 'unknown error'}`
  }

  task?.finish(incomplete ? 'incomplete' : 'done')
  logLine(
    'agent',
    `done tools=${toolRuns.length} nudges=${nudges} elapsed=${Date.now() - startedAt}ms incomplete=${incomplete}`
  )
  trace.finish({
    text: finalText,
    nudges,
    incomplete,
    rounds,
    tools: toolRuns.map((run) => ({ name: run.name, status: run.status, ms: run.ms, summary: run.summary }))
  })

  return { text: finalText, hadTools, toolRuns, forcedChat, incomplete, objective }
}

async function executeRound(
  prepared: PreparedCall[],
  attempts: Map<string, Attempt[]>,
  input: AgentInput,
  trace: TurnTrace
): Promise<ToolCallOutcome[]> {
  const outcomes = new Array<ToolCallOutcome>(prepared.length)
  let cursor = 0

  while (cursor < prepared.length) {
    const item = prepared[cursor]
    const parallel = item.decision !== 'block' && isParallelSafe(item.call.name)
    if (!parallel) {
      outcomes[cursor] = await executeOne(item, attempts, input, trace)
      cursor += 1
      continue
    }

    const group: number[] = []
    while (cursor < prepared.length) {
      const next = prepared[cursor]
      if (next.decision === 'block' || !isParallelSafe(next.call.name)) break
      group.push(cursor)
      cursor += 1
    }
    const groupOutcomes = await mapLimit(group, MAX_PARALLEL_TOOLS, (index) =>
      executeOne(prepared[index], attempts, input, trace)
    )
    for (let index = 0; index < group.length; index += 1) {
      outcomes[group[index]] = groupOutcomes[index]
    }
  }

  return outcomes
}

async function executeOne(
  item: PreparedCall,
  attempts: Map<string, Attempt[]>,
  input: AgentInput,
  trace: TurnTrace
): Promise<ToolCallOutcome> {
  input.emit({ type: 'phase', phase: phaseForTool(item.call.name), detail: humanTool(item.call.name) })
  const searchingTooMuch = item.call.name === 'history_search' && (attempts.get(`#${item.call.name}`)?.length ?? 0) >= 2
  const webSearchesExhausted =
    item.call.name === 'web_search' && (attempts.get(`#${item.call.name}`)?.length ?? 0) >= 3
  const researchExhausted =
    item.call.name === 'research' && (attempts.get(`#${item.call.name}`)?.length ?? 0) >= 2

  let outcome: ToolCallOutcome
  if (item.decision === 'block' || searchingTooMuch || webSearchesExhausted || researchExhausted) {
    outcome = {
      ok: false,
      summary: searchingTooMuch || webSearchesExhausted || researchExhausted ? 'stop searching' : 'repeated call blocked',
      durationMs: 0,
      content: researchExhausted
        ? 'You have already run research twice this turn. Another broad pass will not add evidence. Use the sources you have, open one specific URL, or state the gap and answer.'
        : webSearchesExhausted
        ? 'You have already run web_search three times this turn. Another paraphrase will not add evidence. Use the results you have: call research, open one of the direct URLs above, or answer with what is verified and name the gap. Do not search again.'
        : searchingTooMuch
          ? 'You have already searched history this turn. Searching again with different words will not add anything. Act on the results you have: call site_open with the site name, or browser_open with one of the URLs above, then read the page.'
          : repeatMessage(item.call.name, item.previous)
    }
  } else {
    outcome = await executeTool(item.call.name, item.call.args, input.toolContext)
    // The old loop classified transient failures but never actually retried.
    // Do exactly one retry for a network-shaped failure, then trust the result.
    if (
      !outcome.ok &&
      !outcome.denied &&
      item.previous.length === 0 &&
      repeatDecision([{ ok: false, content: outcome.content }]) === 'retry'
    ) {
      logLine('agent', `transient failure, retrying once: ${item.call.name}`)
      trace.nudge(`retry ${item.call.name}`)
      outcome = await executeTool(item.call.name, item.call.args, input.toolContext)
    }
    attempts.set(item.signature, [
      ...item.previous,
      { ok: outcome.ok, content: outcome.content.slice(0, 600) }
    ])
    attempts.set(`#${item.call.name}`, [
      ...(attempts.get(`#${item.call.name}`) ?? []),
      { ok: outcome.ok, content: '' }
    ])
  }

  return outcome
}

function isParallelSafe(name: string): boolean {
  return findTool(name)?.parallelSafe === true
}

function phaseForTool(name: string): AgentPhase {
  if (name === 'research' || name === 'web_search' || name === 'news_digest') return 'researching'
  if (
    name === 'web_read' ||
    name === 'browser_read' ||
    name === 'browser_inspect' ||
    name === 'browser_scroll' ||
    name === 'vault_search' ||
    name === 'vault_read' ||
    name === 'search_notes'
  ) {
    return 'reading'
  }
  return 'acting'
}

function humanTool(name: string): string {
  return name.replace(/_/g, ' ')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('cancelled')
    error.name = 'AbortError'
    throw error
  }
}
