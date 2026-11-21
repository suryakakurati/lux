/**
 * A turn plan, and the deterministic checks that decide whether it is done.
 *
 * The plan is deliberately small: a handful of steps, each one satisfied by a
 * tool that succeeded or by a URL the turn actually read. The model writes the
 * answer; code owns progress, so the loop can tell "finished" from "said it
 * would finish" without another model call.
 */

import { citationFailure } from './citations.ts'

export const PLAN_STEP_KINDS = ['gather', 'act', 'verify', 'answer', 'clarify'] as const
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number]

export const PLAN_SOURCES = ['playbook', 'heuristic', 'generic'] as const
export type PlanSource = (typeof PLAN_SOURCES)[number]

export interface PlanStep {
  id: string
  /** Short imperative line shown in the prompt. */
  title: string
  kind: PlanStepKind
  /** Preferred tool, when the planner found one. */
  tool?: string
  /** Any of these completed calls satisfies the step. */
  accept?: string[]
  /** A URL must have been seen this turn (a page, a dossier, a search result). */
  requiresEvidence?: boolean
  /** A failed optional step never blocks the answer. */
  optional?: boolean
  /** Set by a replan, kept for the trace and the prompt. */
  note?: string
}

export interface Plan {
  version: 1
  objective: string
  steps: PlanStep[]
  source: PlanSource
  playbookId?: string
  /** An underdetermined request may be answered with one targeted question. */
  allowQuestion: boolean
  requireCitations?: number
  requireCitationHosts?: number
  createdAt: number
}

export interface PlanEvidence {
  tools: { name: string; ok: boolean }[]
  urls: string[]
}

export interface PlanVerification {
  done: string[]
  open: PlanStep[]
  failed: PlanStep[]
  complete: boolean
}

const MAX_STEPS = 8
const MAX_TITLE = 160

export function acceptedTools(step: PlanStep): string[] {
  const names = new Set<string>()
  if (step.tool) names.add(step.tool)
  for (const name of step.accept ?? []) names.add(name)
  return [...names]
}

/**
 * A step is satisfied by evidence, not by the model saying so. An answer step
 * needs a real reply; a gather step needs the read it names.
 */
export function stepSatisfied(step: PlanStep, evidence: PlanEvidence, replyChars = 0): boolean {
  if (step.kind === 'clarify') return replyChars > 0
  if (step.kind === 'answer') return replyChars >= 24

  const accepted = acceptedTools(step)
  const matching = evidence.tools.filter((tool) => accepted.includes(tool.name))
  const toolDone = accepted.length > 0 ? matching.some((tool) => tool.ok) : evidence.tools.some((tool) => tool.ok)
  if (!toolDone) return false
  if (step.requiresEvidence) return evidence.urls.length > 0
  return true
}

export function stepFailed(step: PlanStep, evidence: PlanEvidence): boolean {
  const accepted = acceptedTools(step)
  if (accepted.length === 0) return false
  const matching = evidence.tools.filter((tool) => accepted.includes(tool.name))
  return matching.length > 0 && matching.every((tool) => !tool.ok)
}

export function verifyPlan(plan: Plan, evidence: PlanEvidence, replyChars = 0): PlanVerification {
  const done: string[] = []
  const open: PlanStep[] = []
  const failed: PlanStep[] = []
  for (const step of plan.steps) {
    if (stepSatisfied(step, evidence, replyChars)) done.push(step.id)
    else {
      open.push(step)
      if (stepFailed(step, evidence)) failed.push(step)
    }
  }
  return {
    done,
    open,
    failed,
    complete: open.every((step) => step.optional === true)
  }
}

export function openRequiredSteps(plan: Plan, evidence: PlanEvidence): PlanStep[] {
  return plan.steps.filter(
    (step) => !step.optional && !stepSatisfied(step, evidence) && step.kind !== 'answer' && step.kind !== 'clarify'
  )
}

/**
 * What the model needs to see, and nothing else: the steps, what is done, and
 * the one that comes next. Capped so a plan can never crowd out the request.
 */
export function planPrompt(plan: Plan, evidence?: PlanEvidence): string {
  if (plan.steps.length === 0) return ''
  const verification = evidence ? verifyPlan(plan, evidence) : null
  const done = new Set(verification?.done ?? [])
  const source = plan.playbookId ? `${plan.source} ${plan.playbookId}` : plan.source
  const lines = plan.steps.map((step, index) => {
    const mark = done.has(step.id) ? 'x' : ' '
    const tools = acceptedTools(step)
    const suffix = tools.length > 0 ? ` (${tools.slice(0, 2).join(' / ')})` : ''
    return `${index + 1}. [${mark}] ${step.title.slice(0, MAX_TITLE)}${suffix}`
  })
  const next = plan.steps.find((step) => !done.has(step.id) && !step.optional)
  return [
    `Plan (${source}${verification ? `, ${verification.done.length}/${plan.steps.length} done` : ''}):`,
    ...lines,
    next ? `Next: ${next.title}` : '',
    plan.requireCitations ? `Answer must cite ${plan.requireCitations} source URL(s) actually read this turn.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export interface ReplanOptions {
  evidence: PlanEvidence
  /** Tools of the same capability that have not been tried. */
  alternatives?: string[]
  reason: string
}

export interface ReplanResult {
  plan: Plan
  changed: boolean
  reason: string
}

/**
 * Repair the first blocked step, and only that one.
 *
 * A small model does not need a new plan when one tool failed; it needs the
 * same intent pointed at a different tool. If there is no alternative, the
 * step becomes optional so the turn can still answer with what it has.
 */
export function replanPlan(plan: Plan, options: ReplanOptions): ReplanResult {
  const blocked = plan.steps.find(
    (step) => !step.optional && !stepSatisfied(step, options.evidence) && stepFailed(step, options.evidence)
  )
  if (!blocked) return { plan, changed: false, reason: options.reason }

  const alternatives = (options.alternatives ?? []).filter(
    (name) => name !== blocked.tool && !(blocked.accept ?? []).includes(name)
  )
  const steps = plan.steps.map((step) => {
    if (step.id !== blocked.id) return step
    if (alternatives.length > 0) {
      return {
        ...step,
        tool: alternatives[0],
        accept: alternatives.slice(0, 3),
        note: `switched to ${alternatives[0]}`
      }
    }
    return { ...step, optional: true, note: 'no alternative tool; answering with what is available' }
  })
  return {
    plan: { ...plan, steps },
    changed: true,
    reason: alternatives.length > 0 ? `${options.reason}: ${alternatives[0]}` : `${options.reason}: no alternative`
  }
}

/** A reason the final answer is not done yet, or null. */
export function answerGap(plan: Plan, text: string, evidence: PlanEvidence): string | null {
  const required = plan.requireCitations ?? 0
  if (required <= 0) return null
  return citationFailure(text, evidence.urls, {
    citations: required,
    hosts: plan.requireCitationHosts,
    fromEvidence: true
  })
}

export interface MakePlanInput {
  objective: string
  steps: Omit<PlanStep, 'id'>[]
  source: PlanSource
  playbookId?: string
  allowQuestion?: boolean
  requireCitations?: number
  requireCitationHosts?: number
}

export function makePlan(input: MakePlanInput): Plan {
  const steps = input.steps.slice(0, MAX_STEPS).map((step, index) => ({
    ...step,
    id: `step-${index + 1}`,
    title: step.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
  }))
  return {
    version: 1,
    objective: input.objective.replace(/\s+/g, ' ').trim().slice(0, 500),
    steps,
    source: input.source,
    ...(input.playbookId ? { playbookId: input.playbookId } : {}),
    allowQuestion: input.allowQuestion === true,
    ...(input.requireCitations && input.requireCitations > 0
      ? { requireCitations: Math.min(6, input.requireCitations) }
      : {}),
    ...(input.requireCitationHosts && input.requireCitationHosts > 0
      ? { requireCitationHosts: Math.min(6, input.requireCitationHosts) }
      : {}),
    createdAt: Date.now()
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s+/g, ' ').trim()
  if (!clean || clean.length > max) return null
  return clean
}

function names(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const cleaned: string[] = []
  for (const entry of value) {
    const name = text(entry, 64)
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) return null
    if (!cleaned.includes(name)) cleaned.push(name)
  }
  return cleaned
}

/** Validate a plan that came from disk or, later, from a model. */
export function validatePlan(value: unknown): { ok: true; plan: Plan } | { ok: false; error: string } {
  const input = record(value)
  if (!input) return { ok: false, error: 'plan must be an object' }
  if (input.version !== 1) return { ok: false, error: 'unsupported plan version' }
  const objective = text(input.objective, 500)
  if (!objective) return { ok: false, error: 'objective is required' }
  if (!PLAN_SOURCES.includes(input.source as PlanSource)) return { ok: false, error: 'unknown plan source' }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'a plan needs at least one step' }
  }
  if (input.steps.length > MAX_STEPS) return { ok: false, error: `a plan is capped at ${MAX_STEPS} steps` }

  const ids = new Set<string>()
  const steps: PlanStep[] = []
  for (const raw of input.steps) {
    const step = record(raw)
    if (!step) return { ok: false, error: 'each step must be an object' }
    const id = text(step.id, 40)
    const title = text(step.title, MAX_TITLE)
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: 'step id must be a slug' }
    if (ids.has(id)) return { ok: false, error: `duplicate step id ${id}` }
    ids.add(id)
    if (!title) return { ok: false, error: `step ${id} needs a title` }
    if (!PLAN_STEP_KINDS.includes(step.kind as PlanStepKind)) {
      return { ok: false, error: `step ${id} has an unknown kind` }
    }
    const tool = step.tool === undefined ? null : text(step.tool, 64)
    if (step.tool !== undefined && !tool) return { ok: false, error: `step ${id} has an invalid tool` }
    const accept = step.accept === undefined ? null : names(step.accept)
    if (step.accept !== undefined && !accept) return { ok: false, error: `step ${id} has invalid accept tools` }
    const note = step.note === undefined ? null : text(step.note, 160)
    if (step.note !== undefined && !note) return { ok: false, error: `step ${id} has an invalid note` }
    steps.push({
      id,
      title,
      kind: step.kind as PlanStepKind,
      ...(tool ? { tool } : {}),
      ...(accept && accept.length > 0 ? { accept } : {}),
      ...(step.requiresEvidence === true ? { requiresEvidence: true } : {}),
      ...(step.optional === true ? { optional: true } : {}),
      ...(note ? { note } : {})
    })
  }

  return {
    ok: true,
    plan: {
      version: 1,
      objective,
      steps,
      source: input.source as PlanSource,
      ...(text(input.playbookId, 64) ? { playbookId: text(input.playbookId, 64) as string } : {}),
      allowQuestion: input.allowQuestion === true,
      ...(typeof input.requireCitations === 'number' && input.requireCitations > 0
        ? { requireCitations: Math.min(6, Math.floor(input.requireCitations)) }
        : {}),
      ...(typeof input.requireCitationHosts === 'number' && input.requireCitationHosts > 0
        ? { requireCitationHosts: Math.min(6, Math.floor(input.requireCitationHosts)) }
        : {}),
      createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now()
    }
  }
}
