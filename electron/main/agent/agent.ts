import type { Settings, ToolRun } from '../../../shared/types'
import { mapLimit } from '../../../shared/concurrency'
import type { Memory } from './memory'
import type { ModelManager } from './model-manager'
import type { ModelMetrics, OllamaMessage, SamplingOptions } from './ollama'
import { streamChat } from './ollama'
import { extractUrls, normaliseUrl } from '../../../shared/citations'
import { firstSpokenSentence } from '../../../shared/speech'
import { contextBudgetChars, fitContext, truncateToolResult } from '../../../shared/context'
import {
  acceptedTools,
  answerGap,
  openRequiredSteps,
  planPrompt,
  replanPlan,
  verifyPlan,
  type PlanEvidence
} from '../../../shared/plan'
import { alternativesFor, planForTurn } from '../../../shared/planner'
import { listPlaybooks } from './playbooks'
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
  /** Deterministic decoding for measurements. The app leaves this unset. */
  sampling?: SamplingOptions
  /** Research may legitimately take longer than a spoken question. */
  timeBudgetMs?: number
  /** Hard ceiling on model rounds; the last round is reserved for an answer. */
  maxRounds?: number
  /** Hand a complete first sentence to speech before the full answer is ready. */
  onFirstSentence?: (text: string) => void
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
  /** URLs that appeared in this turn's tool output. */
  evidenceUrls: string[]
}

const MAX_TOOL_ROUNDS = 16
/** A turn may chain many steps, but not forever: the person is waiting. */
const TIME_BUDGET_MS = 240_000
/** A research plan is the one deliberate exception; it is not a spoken answer. */
const RESEARCH_TIME_BUDGET_MS = 600_000
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
  const tools = shortlistTools(`${objective} ${input.turnHint ?? ''} ${input.openTask ?? ''}`, allTools, 8)
  const playbooks = listPlaybooks()
  let plan = planForTurn(objective, tools, playbooks)
  // A plan with no action is answered from context. Only discovery stays on the
  // table, so an unexpected need can still escalate without inviting a tool
  // lookup for a question the context already answers.
  const answerOnly = plan.steps.length === 1 && plan.steps[0].kind === 'answer'
  const offered = answerOnly
    ? tools.filter((tool) => tool.function.name === 'discover_tools')
    : tools
  const task = input.taskState
  task?.plan(plan.steps.map((step) => step.title))
  const actionable =
    needsSiteCheck(objective) ||
    needsMusicTaste(objective) ||
    Boolean(input.openTask) ||
    plan.steps.some((step) => step.kind !== 'answer' && step.kind !== 'clarify')

  input.emit({
    type: 'phase',
    phase: 'planning',
    detail:
      plan.steps.length > 1
        ? `${plan.steps.length} steps${plan.playbookId ? ` · ${plan.playbookId}` : ''}.`
        : actionable
          ? 'Working out the approach.'
          : 'Understanding the request.'
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
    tools: offered,
    settings: input.settings,
    turnHint: input.turnHint,
    objective,
    openTask: input.openTask,
    taskState: task?.prompt(),
    plan: planPrompt(plan)
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
    offered: offered.map((tool) => tool.function.name),
    plan: `${plan.source}${plan.playbookId ? `:${plan.playbookId}` : ''} ${plan.steps.length} steps`
  })
  const evidence: PlanEvidence = { tools: [], urls: [] }
  const evidenceKeys = new Set<string>()
  const rememberUrls = (text: string): void => {
    for (const url of extractUrls(text)) {
      const key = normaliseUrl(url)
      if (!key || evidenceKeys.has(key)) continue
      evidenceKeys.add(key)
      evidence.urls.push(url)
      if (evidence.urls.length >= 24) break
    }
  }
  const contextCharsBudget = contextBudgetChars(
    input.settings.contextWindow || 8_192,
    input.settings.maxOutputTokens || 1_536
  )
  const startedAt = Date.now()
  const researchPlan = plan.steps.some(
    (step) => step.tool === 'research' || (step.accept ?? []).includes('research')
  )
  const timeBudgetMs =
    input.timeBudgetMs ?? (researchPlan ? RESEARCH_TIME_BUDGET_MS : TIME_BUDGET_MS)
  // Research still gets a smaller ceiling than an ordinary turn. The last
  // round deliberately closes the toolbox so a model that keeps searching is
  // forced to answer from what it already read.
  const roundLimit = Math.max(
    1,
    Math.min(input.maxRounds ?? (researchPlan ? 8 : MAX_TOOL_ROUNDS), MAX_TOOL_ROUNDS)
  )
  let replanned = false
  let toolUnavailable = false
  let planNudges = 0
  let answerOnlyNudges = 0
  let citationNudges = 0
  let nudges = 0
  let lastToolName = ''
  let lastSummary = ''
  let finalText = ''
  let hadTools = false
  let spokeEarly = false
  let forcedChat = false
  let incomplete = false
  let rounds = 0
  let prefetchedComplete = false

  // Safe, zero-argument reads are the one place the plan can act without the
  // model first choosing the call. Fetching them together removes a whole
  // model round from "battery and clipboard" turns and makes a single-read
  // question a one-round answer. The whitelist is deliberately tiny: no args,
  // no side effects, no confirmations.
  const PREFETCHABLE = new Set([
    'battery_status',
    'get_volume',
    'system_status',
    'clipboard_read',
    'list_apps',
    'now_playing'
  ])
  const prefetchedTools = new Set<string>()
  const prefetchSteps =
    plan.allowQuestion || answerOnly
      ? []
      : plan.steps
          .filter((step) => {
            if (step.kind === 'answer' || step.kind === 'clarify' || step.optional) return false
            if (!step.tool || !PREFETCHABLE.has(step.tool) || prefetchedTools.has(step.tool)) return false
            prefetchedTools.add(step.tool)
            return true
          })
          .slice(0, 3)
  if (prefetchSteps.length > 0) {
    const prefetched = await mapLimit(prefetchSteps, MAX_PARALLEL_TOOLS, async (step) => {
      const name = step.tool as string
      const run: ToolRun = {
        id: `tool-prefetch-${Date.now()}-${toolRuns.length}`,
        name,
        args: {},
        status: 'running'
      }
      toolRuns.push(run)
      input.emit({ type: 'tool-start', run })
      const outcome = await executeTool(name, {}, input.toolContext)
      const finished: ToolRun = {
        ...run,
        status: outcome.ok ? 'ok' : outcome.error_kind === 'denied' ? 'denied' : 'error',
        summary: outcome.summary,
        ms: outcome.durationMs
      }
      const index = toolRuns.findIndex((entry) => entry.id === run.id)
      if (index >= 0) toolRuns[index] = finished
      trace.tool(name, finished.status, outcome.durationMs, outcome.summary, {})
      input.emit({ type: 'tool-end', run: finished })
      evidence.tools.push({ name, ok: outcome.ok })
      rememberUrls(outcome.data)
      task?.tool(name, outcome.ok, outcome.summary, outcome.data, {})
      return { step, outcome, name }
    })
    hadTools = true
    lastToolName = prefetched.map((entry) => entry.name).join(', ')
    lastSummary = prefetched.at(-1)?.outcome.summary ?? ''
    const blocks = prefetched.map(({ name, outcome }) => {
      const data = truncateToolResult(name, outcome.data)
      return `### ${name} (${outcome.ok ? 'ok' : 'failed'})\n${data}${
        outcome.next_hint ? `\nNext: ${outcome.next_hint}` : ''
      }`
    })
    messages.push({
      role: 'system',
      content: `Already read for this request. The plan selected these safe, zero-argument reads; use them and do not call these tools again.\n\n${blocks.join('\n\n')}`
    })
    prefetchedComplete = openRequiredSteps(plan, evidence).length === 0
  }

  logLine(
    'agent',
    `objective=${JSON.stringify(objective.slice(0, 160))} tools=${offered.length}/${allTools.length} promptChars=${system.length} plan=${plan.source}${plan.playbookId ? `:${plan.playbookId}` : ''} steps=${plan.steps.length}${input.openTask ? ' resumed=true' : ''}`
  )

  try {
    for (let round = 0; round < roundLimit; round += 1) {
      throwIfAborted(input.signal)
      rounds = round
      const finalRound = round === roundLimit - 1

      if (Date.now() - startedAt > timeBudgetMs) {
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
      const closedByPrefetch = prefetchedComplete && round === 0 && !answerOnly
      if (closedByPrefetch) {
        messages.push({
          role: 'system',
          content:
            'All planned reads are already complete from the prefetched results. Answer now; tools are closed for this round. Do not repeat those reads.'
        })
      }
      trace.round(round)

      const modelOptions = input.models?.chatOptions() ?? {
        keepAlive: input.settings.keepModelLoaded ? input.settings.modelKeepAlive || '30m' : '0',
        numCtx: input.settings.contextWindow || 8_192,
        numPredict: input.settings.maxOutputTokens || 1_536
      }
      if (finalRound && !answerOnly) {
        const urls = evidence.urls.slice(0, 8).join('\n')
        messages.push({
          role: 'system',
          content: `Final round: tools are closed. Answer now from the evidence already gathered. Cite these exact URLs where they support the answer, and do not invent one:${urls ? `\n${urls}` : ' (no source URLs were found; say so if citations are required).'}`
        })
      }
      const modelStartedAt = Date.now()
      // A fresh view each round: the transcript keeps everything for the task
      // state, but the model only receives what fits next to its answer.
      const requestMessages = fitContext(messages, contextCharsBudget)
      const stream = await streamChat({
        url: input.settings.ollamaUrl,
        model: input.settings.model,
        messages: requestMessages,
        tools: finalRound || closedByPrefetch ? [] : offered,
        keepAlive: modelOptions.keepAlive,
        numCtx: modelOptions.numCtx,
        numPredict: modelOptions.numPredict,
        sampling: input.sampling,
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
          if (!spokeEarly && input.onFirstSentence && !actionable && !hadTools) {
            const sentence = firstSpokenSentence(roundText)
            if (sentence) {
              spokeEarly = true
              input.onFirstSentence(sentence)
            }
          }
        }
        if (chunk.toolCalls) accumulator.add(chunk.toolCalls)
      }

      const promptChars = requestMessages.reduce((sum, message) => sum + message.content.length, 0)
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

      // The plan needs no action and no schemas were offered. A tool call here
      // is a habit, not information: asking for the direct answer is cheaper
      // and more correct than executing a timer lookup for "what time is it".
      if (answerOnly && calls.length > 0) {
        if (answerOnlyNudges < 1 && round < roundLimit - 1) {
          answerOnlyNudges += 1
          trace.nudge(`answer-only: ignored ${calls[0].name}`)
          task?.note(`answered from context; ignored an unnecessary ${calls[0].name} call`)
          messages.push({
            role: 'user',
            content:
              'This request is answered from the context already in this conversation. Do not call a tool. Answer now in one or two sentences.'
          })
          input.emit({ type: 'replace', text: '' })
          continue
        }
        finalText =
          roundText.trim() ||
          'I have what I need in the current context, but I could not put it into an answer. Ask me again and I will keep it to the context.'
        break
      }

      if (calls.length === 0) {
        const reply = roundText.trim()

        // A mandatory plan step that is still open is one more action, not a
        // new request. Nudge once; a genuine blocker still gets to end the turn.
        const open = plan.allowQuestion ? [] : openRequiredSteps(plan, evidence)
        if (open.length > 0 && planNudges < 1 && round < roundLimit - 1) {
          planNudges += 1
          const step = open[0]
          trace.nudge(`plan open: ${step.title}`)
          task?.note(`plan step still open: ${step.title}`)
          messages.push({
            role: 'user',
            content: `The plan is not finished: "${step.title}". Do it now with ${acceptedTools(step).join(' or ')}, then answer from the result. If it is genuinely blocked, say exactly what blocked it in one line.`
          })
          input.emit({ type: 'replace', text: '' })
          continue
        }

        // A citation is a URL that was actually in the evidence. Asking once
        // for the missing URLs is cheaper and more reliable than a rewrite.
        const gap = answerGap(plan, reply, evidence)
        if (gap && citationNudges < 2 && round < roundLimit - 1) {
          citationNudges += 1
          trace.nudge(`citations: ${gap}`)
          task?.note(`answer not yet citable: ${gap}`)
          messages.push({
            role: 'user',
            content: `The answer is not verifiable yet: ${gap}. Add the exact URL of each source you actually read, next to the claim it supports. Do not invent links and do not cite a page you did not open.`
          })
          input.emit({ type: 'replace', text: '' })
          continue
        }

        const stall = stallReason(reply, { usedTools: hadTools, actionable, toolUnavailable })

        if (stall && nudges < MAX_NUDGES && round < roundLimit - 1) {
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
        if (nudges > 0 || planNudges > 0 || citationNudges > 0) {
          input.emit({ type: 'replace', text: reply })
        }
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
        if (reportsUnavailable(item.call.name, outcome.data)) toolUnavailable = outcome.ok
        evidence.tools.push({ name: item.call.name, ok: outcome.ok })
        rememberUrls(outcome.data)
        if (typeof item.call.args.url === 'string') rememberUrls(item.call.args.url)
        const modelData = truncateToolResult(item.call.name, outcome.data)
        if (modelData.length !== outcome.data.length) outcome.truncated = true
        messages.push({
          role: 'tool',
          tool_name: item.call.name,
          content: outcome.next_hint ? `${modelData}\n\nNext: ${outcome.next_hint}` : modelData
        })
        task?.tool(item.call.name, outcome.ok, outcome.summary, outcome.data, item.call.args)
      }

      // Verify against what actually ran, then repair at most one blocked step.
      // A second failure means the capability is missing, not the choice.
      const verification = verifyPlan(plan, evidence)
      if (!replanned && verification.failed.length > 0) {
        const blocked = verification.failed[0]
        const repaired = replanPlan(plan, {
          evidence,
          alternatives: alternativesFor(blocked, tools),
          reason: `${blocked.tool ?? 'step'} failed`
        })
        if (repaired.changed) {
          plan = repaired.plan
          replanned = true
          task?.plan(plan.steps.map((step) => step.title))
          const next = plan.steps.find((step) => step.id === blocked.id)
          messages.push({
            role: 'system',
            content: `Plan updated (${repaired.reason}). Do not repeat the failed call. ${
              next
                ? `Continue with "${next.title}" using ${acceptedTools(next).join(' or ')}.`
                : 'Answer with what you already have and name the gap.'
            }`
          })
          trace.nudge(`replan ${repaired.reason}`)
          logLine('agent', `replanned: ${repaired.reason}`)
        }
      }

      // The compact URL list survives even when a tool result is truncated or
      // an old batch is dropped. It is the only source of citations the answer
      // is allowed to use.
      if (evidence.urls.length > 0) {
        const content = `URLs actually seen this turn (cite these exact URLs; never invent one):\n${evidence.urls
          .slice(0, 16)
          .join('\n')}`
        const existing = messages.findIndex(
          (message, index) =>
            index > 0 && message.role === 'system' && message.content.startsWith('URLs actually seen this turn')
        )
        if (existing >= 0) messages[existing] = { role: 'system', content }
        else messages.push({ role: 'system', content })
      }

      // Re-state the compact task state after a batch. Replace the previous
      // copy instead of appending one per round; a long turn otherwise spends
      // its context on fourteen overlapping summaries of itself.
      if (task) {
        const content = task.prompt(true)
        const existing = messages.findIndex(
          (message, index) =>
            index > 0 && message.role === 'system' && message.content.startsWith('Task state')
        )
        if (existing >= 0) messages[existing] = { role: 'system', content }
        else messages.push({ role: 'system', content })
      }

      if (finalRound) {
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

  return { text: finalText, hadTools, toolRuns, forcedChat, incomplete, objective, evidenceUrls: evidence.urls }
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
      data: researchExhausted
        ? 'You have already run research twice this turn. Another broad pass will not add evidence. Use the sources you have, open one specific URL, or state the gap and answer.'
        : webSearchesExhausted
        ? 'You have already run web_search three times this turn. Another paraphrase will not add evidence. Use the results you have: call research, open one of the direct URLs above, or answer with what is verified and name the gap. Do not search again.'
        : searchingTooMuch
          ? 'You have already searched history this turn. Searching again with different words will not add anything. Act on the results you have: call site_open with the site name, or browser_open with one of the URLs above, then read the page.'
          : repeatMessage(item.call.name, item.previous),
      truncated: false,
      error_kind: 'failed',
      next_hint: 'Use the evidence already gathered; do not repeat the same call.',
      summary: searchingTooMuch || webSearchesExhausted || researchExhausted ? 'stop searching' : 'repeated call blocked',
      durationMs: 0
    }
  } else {
    outcome = await executeTool(item.call.name, item.call.args, input.toolContext)
    // The old loop classified transient failures but never actually retried.
    // Do exactly one retry for a network-shaped failure, then trust the result.
    if (
      !outcome.ok &&
      !outcome.denied &&
      item.previous.length === 0 &&
      repeatDecision([{ ok: false, content: outcome.data }]) === 'retry'
    ) {
      logLine('agent', `transient failure, retrying once: ${item.call.name}`)
      trace.nudge(`retry ${item.call.name}`)
      outcome = await executeTool(item.call.name, item.call.args, input.toolContext)
    }
    attempts.set(item.signature, [
      ...item.previous,
      { ok: outcome.ok, content: outcome.data.slice(0, 600) }
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

/** "Spotify is closed" is an answer, so offering to open it is not a stall. */
function reportsUnavailable(name: string, content: string): boolean {
  if (!['now_playing', 'music_taste', 'play_music', 'spotify_control'].includes(name)) return false
  return /(?:not running|isn't running|is not running|isn't open|is not open|closed|nothing is playing|no track|not installed)/i.test(
    content
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('cancelled')
    error.name = 'AbortError'
    throw error
  }
}
