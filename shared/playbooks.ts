/**
 * Playbooks: small, inspectable plans for requests Lux already understands.
 *
 * A playbook is data, not code. It is matched by lexical retrieval against the
 * request (no per-task regexes), validated before use, and turned into the same
 * Plan the heuristic planner produces. A person's own playbook lives in their
 * data directory; a saved playbook passes through the normal confirmation gate
 * before it is written.
 */

import type { Plan, PlanStepKind } from './plan.ts'
import { makePlan } from './plan.ts'

export interface PlaybookStep {
  title: string
  kind: PlanStepKind
  tool?: string
  accept?: string[]
  requiresEvidence?: boolean
  optional?: boolean
}

export interface Playbook {
  version: 1
  id: string
  title: string
  description: string
  keywords: string[]
  examples?: string[]
  steps: PlaybookStep[]
  requireCitations?: number
  requireCitationHosts?: number
}

export interface RankedPlaybook {
  playbook: Playbook
  score: number
  matched: string[]
}

const MAX_STEPS = 6
const MAX_KEYWORDS = 20

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text || text.length > max) return null
  return text
}

function toolNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  for (const entry of value) {
    const name = cleanText(entry, 64)
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) return null
    if (!result.includes(name)) result.push(name)
  }
  return result
}

export function validatePlaybook(
  value: unknown
): { ok: true; playbook: Playbook } | { ok: false; error: string } {
  const input = record(value)
  if (!input) return { ok: false, error: 'playbook must be an object' }
  if (input.version !== 1) return { ok: false, error: 'unsupported playbook version' }
  const id = cleanText(input.id, 64)
  if (!id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    return { ok: false, error: 'id must be a lowercase slug' }
  }
  const title = cleanText(input.title, 80)
  if (!title) return { ok: false, error: 'title is required' }
  const description = cleanText(input.description, 240)
  if (!description) return { ok: false, error: 'description is required' }
  if (!Array.isArray(input.keywords) || input.keywords.length === 0) {
    return { ok: false, error: 'at least one keyword is required' }
  }
  if (input.keywords.length > MAX_KEYWORDS) {
    return { ok: false, error: `at most ${MAX_KEYWORDS} keywords` }
  }
  const keywords: string[] = []
  for (const entry of input.keywords) {
    const keyword = cleanText(entry, 40)?.toLowerCase()
    if (!keyword) return { ok: false, error: 'keywords must be short strings' }
    if (!keywords.includes(keyword)) keywords.push(keyword)
  }
  const examples = input.examples === undefined ? [] : (input.examples as unknown[])
  if (!Array.isArray(examples)) return { ok: false, error: 'examples must be an array' }
  const exampleLines: string[] = []
  for (const entry of examples) {
    const line = cleanText(entry, 200)
    if (!line) return { ok: false, error: 'examples must be short strings' }
    exampleLines.push(line)
  }

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return { ok: false, error: 'a playbook needs at least one step' }
  }
  if (input.steps.length > MAX_STEPS) return { ok: false, error: `at most ${MAX_STEPS} steps` }
  const steps: PlaybookStep[] = []
  for (const raw of input.steps) {
    const step = record(raw)
    if (!step) return { ok: false, error: 'each step must be an object' }
    const stepTitle = cleanText(step.title, 160)
    if (!stepTitle) return { ok: false, error: 'each step needs a title' }
    if (!['gather', 'act', 'verify', 'answer', 'clarify'].includes(String(step.kind))) {
      return { ok: false, error: `step "${stepTitle}" has an unknown kind` }
    }
    const tool = step.tool === undefined ? null : cleanText(step.tool, 64)
    if (step.tool !== undefined && (!tool || !/^[a-z][a-z0-9_]*$/.test(tool))) {
      return { ok: false, error: `step "${stepTitle}" has an invalid tool` }
    }
    const accept = step.accept === undefined ? null : toolNames(step.accept)
    if (step.accept !== undefined && !accept) {
      return { ok: false, error: `step "${stepTitle}" has invalid accept tools` }
    }
    steps.push({
      title: stepTitle,
      kind: step.kind as PlaybookStep['kind'],
      ...(tool ? { tool } : {}),
      ...(accept && accept.length > 0 ? { accept } : {}),
      ...(step.requiresEvidence === true ? { requiresEvidence: true } : {}),
      ...(step.optional === true ? { optional: true } : {})
    })
  }

  const citations = typeof input.requireCitations === 'number' ? Math.floor(input.requireCitations) : 0
  if (citations < 0 || citations > 6) return { ok: false, error: 'requireCitations must be 0–6' }
  const hosts = typeof input.requireCitationHosts === 'number' ? Math.floor(input.requireCitationHosts) : 0
  if (hosts < 0 || hosts > 6) return { ok: false, error: 'requireCitationHosts must be 0–6' }

  return {
    ok: true,
    playbook: {
      version: 1,
      id,
      title,
      description,
      keywords,
      ...(exampleLines.length > 0 ? { examples: exampleLines } : {}),
      steps,
      ...(citations > 0 ? { requireCitations: citations } : {}),
      ...(hosts > 0 ? { requireCitationHosts: hosts } : {})
    }
  }
}

/** Grammar words that must not make two unrelated requests look alike. */
const STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'these', 'those', 'what', 'when',
  'where', 'which', 'who', 'how', 'why', 'you', 'your', 'our', 'their', 'them', 'they',
  'have', 'has', 'had', 'was', 'were', 'are', 'does', 'did', 'doing', 'done', 'can',
  'could', 'would', 'should', 'will', 'please', 'some', 'any', 'all', 'out', 'into',
  'about', 'there', 'here', 'its', 'not', 'but', 'then', 'than', 'too', 'very', 'also',
  'just', 'now', 'right', 'use', 'using', 'make', 'much', 'many', 'tell', 'show', 'give',
  'want', 'need', 'like', 'help', 'my', 'me', 'i', 'is', 'it', 'on', 'in', 'of', 'to',
  'a', 'an', 'at', 'or', 'be', 'do', 'get', 'got'
])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3 && !STOP.has(word))
}

/**
 * Lexical retrieval, not intent detection. Keywords are phrases the person
 * would actually use; a single shared common word is not enough to select a
 * playbook.
 */
export function rankPlaybooks(objective: string, playbooks: Playbook[]): RankedPlaybook[] {
  const query = ` ${objective.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  const queryWords = new Set(words(objective))
  return playbooks
    .map((playbook) => {
      const matched: string[] = []
      let score = 0
      for (const keyword of playbook.keywords) {
        const phrase = ` ${keyword.replace(/[^a-z0-9]+/g, ' ')} `
        if (phrase.trim().includes(' ') ? query.includes(phrase) : queryWords.has(keyword)) {
          score += phrase.trim().includes(' ') ? 3 : 2
          matched.push(keyword)
        }
      }
      const titleWords = new Set(words(`${playbook.title} ${playbook.description}`))
      let overlap = 0
      for (const word of queryWords) {
        if (titleWords.has(word)) {
          overlap += 1
          if (overlap <= 4) score += 1
        }
      }
      for (const example of playbook.examples ?? []) {
        const shared = words(example).filter((word) => queryWords.has(word)).length
        if (shared >= 2) {
          score += Math.min(3, shared)
          matched.push('example')
          break
        }
      }
      return { playbook, score, matched }
    })
    .sort((a, b) => b.score - a.score || a.playbook.id.localeCompare(b.playbook.id))
}

/**
 * The one playbook worth following, or null when the request is not clearly
 * about one of them. A near-tie is treated as no match: guessing here is worse
 * than the generic planner.
 */
export function bestPlaybook(
  objective: string,
  playbooks: Playbook[],
  minimumScore = 4,
  minimumMargin = 2
): RankedPlaybook | null {
  const ranked = rankPlaybooks(objective, playbooks).filter((entry) => entry.score >= minimumScore)
  if (ranked.length === 0) return null
  const [first, second] = ranked
  if (second && first.score - second.score < minimumMargin) return null
  return first
}

export function planFromPlaybook(playbook: Playbook, objective: string): Plan {
  const steps = playbook.steps.map((step) => ({
    title: step.title,
    kind: step.kind,
    ...(step.tool ? { tool: step.tool } : {}),
    ...(step.accept && step.accept.length > 0 ? { accept: step.accept } : {}),
    ...(step.requiresEvidence ? { requiresEvidence: true } : {}),
    ...(step.optional ? { optional: true } : {})
  }))
  if (!steps.some((step) => step.kind === 'answer' || step.kind === 'clarify')) {
    steps.push({ title: 'Answer from what was actually read', kind: 'answer' })
  }
  return makePlan({
    objective,
    steps,
    source: 'playbook',
    playbookId: playbook.id,
    allowQuestion: false,
    ...(playbook.requireCitations ? { requireCitations: playbook.requireCitations } : {}),
    ...(playbook.requireCitationHosts ? { requireCitationHosts: playbook.requireCitationHosts } : {})
  })
}
