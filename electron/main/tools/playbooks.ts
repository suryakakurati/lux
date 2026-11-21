import type { Playbook } from '../../../shared/playbooks'
import { rankPlaybooks, validatePlaybook } from '../../../shared/playbooks'
import { listPlaybooks, savePlaybook } from '../agent/playbooks'
import type { ToolDef } from './types'

/**
 * Reading and saving playbooks.
 *
 * Saving is a confirmed action: the person sees the proposed plan and approves
 * it before it is written. That confirmation is the draft approval — there is no
 * silent path from a model suggestion to a stored playbook.
 */
export const playbookTools: ToolDef[] = [
  {
    name: 'list_playbooks',
    description:
      'List the plans Lux already has for recurring requests, with their steps. Use before inventing an approach, and when the person asks what Lux can do by itself.',
    risk: 'safe',
    parallelSafe: true,
    timeoutMs: 5_000,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional words to match against playbook titles and keywords.' }
      }
    },
    async run(args) {
      const query = String(args.query ?? '').trim()
      const playbooks = listPlaybooks()
      const selected = query
        ? rankPlaybooks(query, playbooks)
            .filter((entry) => entry.score > 0)
            .map((entry) => entry.playbook)
        : playbooks
      if (selected.length === 0) {
        return { content: 'No saved playbook matches that yet.', summary: 'no playbook match' }
      }
      return {
        content: [
          'Playbooks (reviewed plans Lux follows when a request matches):',
          ...selected.map(
            (playbook) =>
              `- ${playbook.id}: ${playbook.title} — ${playbook.description}\n  steps: ${playbook.steps
                .map((step) => step.title)
                .join(' → ')}`
          ),
          'A new recurring workflow can be saved with save_playbook; the person approves it first.'
        ].join('\n'),
        summary: `${selected.length} playbooks`
      }
    }
  },
  {
    name: 'save_playbook',
    description:
      'Propose a reusable plan for a recurring request. The person sees and approves it before it is saved. Use only when a workflow is likely to repeat, not for a one-off answer.',
    risk: 'confirm',
    timeoutMs: 5_000,
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human title, e.g. "Weekly review".' },
        description: { type: 'string', description: 'One sentence: when this plan should be used.' },
        keywords: {
          type: 'string',
          description: 'Comma-separated words or phrases a matching request would contain.'
        },
        steps: {
          type: 'string',
          description:
            'One step per line as "kind | tool | title". kind is gather, act, verify or answer. tool is a tool name or "-" for none. Example: "gather | research | Collect the sources".'
        },
        requireCitations: {
          type: 'integer',
          description: 'How many real source URLs the answer must cite (0–6, default 0).',
          minimum: 0,
          maximum: 6
        },
        reason: { type: 'string', description: 'Why this is worth saving. Shown in the approval.' }
      },
      required: ['title', 'description', 'keywords', 'steps']
    },
    async run(args) {
      const title = String(args.title ?? '').trim()
      const description = String(args.description ?? '').trim()
      const keywords = String(args.keywords ?? '')
        .split(/[,\n]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean)
      const rawSteps = String(args.steps ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      const steps = rawSteps.map((line) => {
        const [kind, tool, ...rest] = line.split('|').map((part) => part.trim())
        return {
          kind,
          ...(tool && tool !== '-' ? { tool } : {}),
          title: rest.join(' | ')
        }
      })
      const id = slug(title)
      const candidate: Playbook = {
        version: 1,
        id,
        title,
        description,
        keywords,
        steps: steps.map((step) => ({
          title: step.title,
          kind: step.kind as Playbook['steps'][number]['kind'],
          ...(step.tool ? { tool: step.tool, accept: [step.tool] } : {})
        })),
        ...(Number(args.requireCitations ?? 0) > 0
          ? { requireCitations: Math.min(6, Math.max(1, Number(args.requireCitations))) }
          : {})
      }
      const validated = validatePlaybook(candidate)
      if (!validated.ok) {
        return {
          content: `That playbook is not valid: ${validated.error}. Fix it and propose it again.`,
          summary: 'invalid playbook'
        }
      }
      const file = savePlaybook(validated.playbook)
      return {
        content: `Saved the playbook "${validated.playbook.title}" as ${validated.playbook.id} (${file}). It will be considered on later matching requests.`,
        summary: `saved playbook ${validated.playbook.id}`
      }
    }
  }
]

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'playbook'
  )
}
