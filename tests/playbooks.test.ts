import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Playbook } from '../shared/playbooks.ts'
import { bestPlaybook, planFromPlaybook, validatePlaybook } from '../shared/playbooks.ts'

function seeds(): Playbook[] {
  const dir = join(process.cwd(), 'playbooks')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const validated = validatePlaybook(JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown)
      assert.equal(validated.ok, true, `${name}: ${validated.ok ? '' : validated.error}`)
      return validated.ok ? validated.playbook : (null as never)
    })
}

test('every seed playbook is valid and the ids are unique', () => {
  const playbooks = seeds()
  assert.ok(playbooks.length >= 8, `expected at least 8 seeds, found ${playbooks.length}`)
  assert.equal(new Set(playbooks.map((playbook) => playbook.id)).size, playbooks.length)
  for (const playbook of playbooks) {
    assert.ok(playbook.steps.some((step) => step.kind === 'answer'), `${playbook.id} has no answer step`)
  }
})

test('requests select the right playbook, and vague ones select none', () => {
  const playbooks = seeds()
  assert.equal(
    bestPlaybook('Research the current state of local LLM runtimes for a 16 GB Mac and cite two sources.', playbooks)
      ?.playbook.id,
    'research-brief'
  )
  assert.equal(
    bestPlaybook('Compare two local model runners and recommend one for a 16 GB Mac, with sources.', playbooks)
      ?.playbook.id,
    'compare-options'
  )
  assert.equal(
    bestPlaybook('What changed in the latest Ollama release? Use current sources.', playbooks)?.playbook.id,
    'latest-release'
  )
  assert.equal(
    bestPlaybook('How is this machine doing — CPU, memory and disk?', playbooks)?.playbook.id,
    'system-checkup'
  )
  assert.equal(bestPlaybook('Handle my music.', playbooks), null)
  assert.equal(bestPlaybook('Deal with that thing from yesterday.', playbooks), null)
  // A shared article or "what" is not a topic: these are not playbook requests.
  assert.equal(bestPlaybook("What's the output volume?", playbooks), null)
  assert.equal(bestPlaybook("Read my clipboard and tell me what's on it.", playbooks), null)
  assert.equal(bestPlaybook('What do I have to do today?', playbooks)?.playbook.id, 'morning-review')
  assert.equal(
    bestPlaybook('Find where I wrote down the deployment steps', playbooks)?.playbook.id,
    'workspace-recall'
  )
})

test('a playbook becomes a plan with its citation requirement intact', () => {
  const playbook = seeds().find((entry) => entry.id === 'research-brief')
  assert.ok(playbook)
  const plan = planFromPlaybook(playbook, 'Research this and cite two sources.')
  assert.equal(plan.source, 'playbook')
  assert.equal(plan.playbookId, 'research-brief')
  assert.equal(plan.requireCitations, 2)
  assert.equal(plan.requireCitationHosts, 2)
  assert.ok(plan.steps.some((step) => step.kind === 'answer'))
})

test('an invalid playbook is rejected with a specific reason', () => {
  const bad = validatePlaybook({
    version: 1,
    id: 'Bad Id',
    title: 'x',
    description: 'y',
    keywords: ['k'],
    steps: [{ title: 'do', kind: 'answer' }]
  })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /slug/)
})
