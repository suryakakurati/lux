/**
 * Cheap, deterministic planning.
 *
 * A plan is built once per turn from the request, the shortlisted tools and the
 * playbook catalog. No extra model call: on a small local model a planning round
 * would cost more than the step it plans. The model still decides what to call;
 * the plan gives it an ordered intent and gives the loop something concrete to
 * verify, repair and nudge against.
 */

import type { Plan, PlanStep } from './plan.ts'
import { makePlan } from './plan.ts'
import type { Playbook } from './playbooks.ts'
import { bestPlaybook, planFromPlaybook } from './playbooks.ts'
import { rankTools, type ToolSchema } from './tool-router.ts'

/** Vague verbs that start a request with no object to act on. */
const VAGUE_START = /^(?:handle|deal with|sort out|take care of|do something about|fix|look at|see to)\b/i

/** "that thing", "the stuff" — a reference only the person can resolve. */
const LOOSE_REFERENCE = /\b(?:that|this|the) (?:thing|stuff|one|business)\b/i

/** A score a tool name match needs before a step is mandatory. */
const CONFIDENT_TOOL_SCORE = 6
/** A description-only coincidence is not enough to add a step. */
const MIN_TOOL_SCORE = 2

/**
 * Choose one tool for a clause, and refuse a tie.
 *
 * "read the heading" matches every tool with "read" in its name equally. A
 * coin toss between clipboard_read and web_read produces a plan that is worse
 * than no step at all, so ties fall through to the answer step.
 */
function pickTool(clause: string, tools: ToolSchema[]): ToolSchema | null {
  const ranked = rankTools(clause, tools).filter((entry) => entry.score >= MIN_TOOL_SCORE)
  if (ranked.length === 0) return null
  const topScore = ranked[0].score
  const tied = ranked.filter((entry) => entry.score === topScore)
  if (tied.length === 1) return tied[0].tool
  const queryWords = new Set(
    clause
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4)
  )
  const overlap = (tool: ToolSchema): number =>
    new Set(
      tool.function.description
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && queryWords.has(word))
    ).size
  const scored = tied.map((entry) => ({ tool: entry.tool, overlap: overlap(entry.tool) })).sort((a, b) => b.overlap - a.overlap)
  if (scored[0].overlap > (scored[1]?.overlap ?? 0)) return scored[0].tool

  // A question about the clipboard should not be answered by the writer.
  // This is verb polarity, not topic detection: read-intent clauses prefer a
  // tool whose name does not mutate anything.
  if (/\b(?:what|what's|which|where|who|how|when|list|show|tell|read|check|find|get|is|are)\b/i.test(clause)) {
    const mutating = /(?:^|_)(?:write|set|add|delete|remove|play|open|send|create|change|toggle|lock|take|quit|run|fill|submit|press|click)(?:_|$)/
    const readers = tied.filter((entry) => !mutating.test(entry.tool.function.name))
    if (readers.length === 1) return readers[0].tool
  }
  return null
}

export function isUnderdetermined(objective: string): boolean {
  const content = objective
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3).length
  if (content > 7) return false
  return VAGUE_START.test(objective.trim()) || LOOSE_REFERENCE.test(objective)
}

export function splitClauses(objective: string): string[] {
  return objective
    .split(/\b(?:and then|then|and)\b|[,;]/i)
    .map((clause) => clause.replace(/\s+/g, ' ').replace(/^[\s—-]+|[\s.?!]+$/g, '').trim())
    .filter((clause) => clause.length > 0)
}

/** Tools that answer the same need should not become two rounds. */
function family(name: string): string {
  if (/^(browser_|web_|site_open$|research$|news_digest$|search_web$|history_search$)/.test(name)) {
    return 'reading'
  }
  if (/^(music_taste$|now_playing$|play_music$|spotify_|apple_music_)/.test(name)) return 'music'
  if (/^(vault_|search_notes$|write_note$|remember$)/.test(name)) return 'notes'
  if (/^agni_/.test(name)) return 'agni'
  return name
}

function acceptFor(name: string): string[] {
  if (name === 'browser_open') return ['browser_open', 'browser_read', 'web_read', 'site_open']
  if (name === 'browser_read') return ['browser_read', 'browser_open', 'web_read']
  if (name === 'web_read' || name === 'site_open') return ['web_read', 'browser_open', 'browser_read', 'site_open']
  if (name === 'research') return ['research', 'web_search', 'web_read']
  if (name === 'web_search') return ['web_search', 'research']
  if (name === 'battery_status') return ['battery_status', 'system_status']
  // system_status already carries the volume line in the machine context.
  if (name === 'get_volume') return ['get_volume', 'system_status']
  if (name === 'now_playing' || name === 'music_taste') return ['now_playing', 'music_taste']
  if (name === 'find_files') return ['find_files']
  return [name]
}

function isReading(name: string): boolean {
  return family(name) === 'reading'
}

function wantsSources(objective: string): boolean {
  return /\b(?:cite|cited|citations?|sources?|references?)\b/i.test(objective)
}

function citationRequirement(objective: string): { citations: number; hosts: number } | null {
  if (!wantsSources(objective)) return null
  const explicit = /\b(\d+)\s+(?:different\s+)?(?:sources?|citations?)\b/i.exec(objective)
  const citations = Math.min(4, Math.max(2, explicit ? Number(explicit[1]) : 2))
  return { citations, hosts: citations >= 2 ? 2 : 1 }
}

/**
 * Build the turn's plan.
 *
 * 1. A clearly matching playbook wins: it is the reviewed version of the plan.
 * 2. Otherwise each clause of the request is scored against the tool catalog;
 *    a confident tool-name match makes a mandatory step, a weak one stays
 *    optional so a lexical miss never forces a pointless round.
 * 3. A request with no actionable clause is answered from context, or asked
 *    about once when it is genuinely underdetermined.
 */
export function planForTurn(objective: string, tools: ToolSchema[], playbooks: Playbook[]): Plan {
  const matched = bestPlaybook(objective, playbooks)
  if (matched) return planFromPlaybook(matched.playbook, objective)

  const underdetermined = isUnderdetermined(objective)
  if (underdetermined) {
    return makePlan({
      objective,
      steps: [{ title: 'Ask one targeted question that resolves the request', kind: 'clarify' }],
      source: 'generic',
      allowQuestion: true
    })
  }
  const picked: { name: string; score: number; title: string }[] = []
  const seen = new Set<string>()

  for (const clause of splitClauses(objective)) {
    const tool = pickTool(clause, tools)
    if (!tool) continue
    const name = tool.function.name
    const key = family(name)
    if (seen.has(key)) continue
    seen.add(key)
    const score = rankTools(clause, [tool])[0]?.score ?? 0
    picked.push({ name, score, title: clause.slice(0, 100) })
    if (picked.length >= 3) break
  }

  if (picked.length === 0) {
    return makePlan({
      objective,
      steps: [
        underdetermined
          ? { title: 'Ask one targeted question that resolves the request', kind: 'clarify' }
          : { title: 'Answer directly from context', kind: 'answer' }
      ],
      source: underdetermined ? 'generic' : 'heuristic',
      allowQuestion: underdetermined
    })
  }

  const steps: Omit<PlanStep, 'id'>[] = picked.map((entry) => {
    const mandatory = entry.score >= CONFIDENT_TOOL_SCORE && !underdetermined
    return {
      title: entry.title,
      kind: isReading(entry.name) ? 'gather' : 'act',
      tool: entry.name,
      accept: acceptFor(entry.name),
      ...(isReading(entry.name) ? { requiresEvidence: true } : {}),
      ...(mandatory ? {} : { optional: true })
    }
  })
  steps.push({ title: 'Answer from what the tools returned', kind: 'answer' })

  const citations = citationRequirement(objective)
  return makePlan({
    objective,
    steps,
    source: 'heuristic',
    allowQuestion: underdetermined,
    ...(citations ? { requireCitations: citations.citations, requireCitationHosts: citations.hosts } : {})
  })
}

/** Alternatives to try when a step's chosen tool failed. */
export function alternativesFor(step: PlanStep, tools: ToolSchema[]): string[] {
  const chosen = new Set([step.tool, ...(step.accept ?? [])].filter((name): name is string => Boolean(name)))
  const ranked = tools
    .filter((tool) => !chosen.has(tool.function.name) && family(tool.function.name) === family(step.tool ?? ''))
    .map((tool) => tool.function.name)
  return ranked.slice(0, 3)
}
