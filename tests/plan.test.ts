import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  answerGap,
  makePlan,
  openRequiredSteps,
  planPrompt,
  replanPlan,
  stepFailed,
  stepSatisfied,
  validatePlan,
  verifyPlan,
  type PlanEvidence
} from '../shared/plan.ts'

const evidence = (tools: { name: string; ok: boolean }[], urls: string[] = []): PlanEvidence => ({ tools, urls })

const batteryPlan = () =>
  makePlan({
    objective: "What's my battery at?",
    source: 'heuristic',
    steps: [{ title: 'Read the battery', kind: 'gather', tool: 'battery_status' }]
  })

test('a plan round-trips through validation and rejects duplicate step ids', () => {
  const plan = batteryPlan()
  const validated = validatePlan(JSON.parse(JSON.stringify(plan)))
  assert.equal(validated.ok, true)
  if (validated.ok) assert.equal(validated.plan.steps[0].tool, 'battery_status')

  const duplicate = {
    ...plan,
    steps: [
      { ...plan.steps[0] },
      { ...plan.steps[0], title: 'a second step with the same id' }
    ]
  }
  const rejected = validatePlan(duplicate)
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.match(rejected.error, /duplicate/)
})

test('a step is satisfied by a successful tool, not by an attempted one', () => {
  const step = batteryPlan().steps[0]
  assert.equal(stepSatisfied(step, evidence([{ name: 'battery_status', ok: false }])), false)
  assert.equal(stepSatisfied(step, evidence([{ name: 'battery_status', ok: true }])), true)
  assert.equal(stepSatisfied(step, evidence([{ name: 'clipboard_read', ok: true }])), false)
  assert.equal(stepFailed(step, evidence([{ name: 'battery_status', ok: false }])), true)
})

test('verification separates done, open and failed steps', () => {
  const plan = makePlan({
    objective: 'two reads',
    source: 'generic',
    steps: [
      { title: 'battery', kind: 'gather', tool: 'battery_status' },
      { title: 'clipboard', kind: 'gather', tool: 'clipboard_read' }
    ]
  })
  const result = verifyPlan(
    plan,
    evidence([
      { name: 'battery_status', ok: true },
      { name: 'clipboard_read', ok: false }
    ])
  )
  assert.deepEqual(result.done, ['step-1'])
  assert.deepEqual(result.failed.map((step) => step.id), ['step-2'])
  assert.equal(result.complete, false)
  assert.equal(openRequiredSteps(plan, evidence([])).length, 2)
})

test('a blocked step is repaired with one alternative, or made optional', () => {
  const plan = batteryPlan()
  const repaired = replanPlan(plan, {
    evidence: evidence([{ name: 'battery_status', ok: false }]),
    alternatives: ['system_status'],
    reason: 'battery_status failed'
  })
  assert.equal(repaired.changed, true)
  assert.equal(repaired.plan.steps[0].tool, 'system_status')
  assert.equal(
    stepSatisfied(repaired.plan.steps[0], evidence([{ name: 'system_status', ok: true }])),
    true
  )

  const noAlternative = replanPlan(plan, {
    evidence: evidence([{ name: 'battery_status', ok: false }]),
    alternatives: [],
    reason: 'no other reader'
  })
  assert.equal(noAlternative.changed, true)
  assert.equal(noAlternative.plan.steps[0].optional, true)
  assert.equal(verifyPlan(noAlternative.plan, evidence([{ name: 'battery_status', ok: false }])).complete, true)
})

test('the plan prompt marks completed steps and names the next one', () => {
  const plan = makePlan({
    objective: 'two reads',
    source: 'playbook',
    playbookId: 'system-checkup',
    steps: [
      { title: 'Read the battery', kind: 'gather', tool: 'battery_status' },
      { title: 'Read the clipboard', kind: 'gather', tool: 'clipboard_read' }
    ]
  })
  const prompt = planPrompt(plan, evidence([{ name: 'battery_status', ok: true }]))
  assert.match(prompt, /\[x\] Read the battery/)
  assert.match(prompt, /\[ \] Read the clipboard/)
  assert.match(prompt, /Next: Read the clipboard/)
  assert.match(prompt, /playbook system-checkup/)
})

test('the answer gap requires real, host-diverse citations', () => {
  const plan = makePlan({
    objective: 'research',
    source: 'playbook',
    steps: [{ title: 'Answer', kind: 'answer' }],
    requireCitations: 2,
    requireCitationHosts: 2
  })
  const urls = ['https://a.example/x', 'https://b.example/y']
  assert.match(answerGap(plan, 'No URLs at all.', evidence([], urls)) ?? '', /no source URL/)
  assert.match(
    answerGap(plan, 'Only one [1] https://a.example/x', evidence([], urls)) ?? '',
    /only 1\/2/
  )
  assert.equal(
    answerGap(
      plan,
      'Both [1] https://a.example/x and [2] https://b.example/y agree.',
      evidence([], urls)
    ),
    null
  )
})
