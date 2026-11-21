import type { Playbook } from '../shared/playbooks.ts'
import { planForTurn } from '../shared/planner.ts'
import type { ToolSchema } from '../shared/tool-router.ts'
import { EVAL_CASES, type EvalCase } from './cases.ts'

export interface EvalResult {
  id: string
  ok: boolean
  reasons: string[]
  plan: string
}

export function evaluateCases(tools: ToolSchema[], playbooks: Playbook[]): EvalResult[] {
  return EVAL_CASES.map((entry) => {
    const plan = planForTurn(entry.prompt, tools, playbooks)
    const reasons = check(entry, plan)
    return {
      id: entry.id,
      ok: reasons.length === 0,
      reasons,
      plan: `${plan.source}${plan.playbookId ? `:${plan.playbookId}` : ''} [${plan.steps
        .map((step) => `${step.kind}${step.tool ? `:${step.tool}` : ''}`)
        .join(' → ')}]`
    }
  })
}

function check(entry: EvalCase, plan: ReturnType<typeof planForTurn>): string[] {
  const reasons: string[] = []
  if (entry.playbook && plan.playbookId !== entry.playbook) {
    reasons.push(`expected playbook ${entry.playbook}, got ${plan.playbookId ?? 'none'}`)
  }
  if (entry.tool) {
    const found = plan.steps.some(
      (step) => step.tool === entry.tool || (step.accept ?? []).includes(entry.tool!)
    )
    if (!found) reasons.push(`expected tool ${entry.tool}`)
  }
  if (entry.answerOnly) {
    const answerOnly = plan.steps.length === 1 && plan.steps[0].kind === 'answer'
    if (!answerOnly) reasons.push('expected an answer-only plan')
  }
  if (entry.clarify) {
    const clarifies = plan.allowQuestion === true && plan.steps.some((step) => step.kind === 'clarify')
    if (!clarifies) reasons.push('expected one clarify step')
  }
  if (entry.citations && (plan.requireCitations ?? 0) < entry.citations) {
    reasons.push(`expected at least ${entry.citations} required citations`)
  }
  return reasons
}
