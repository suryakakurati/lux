import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planForTurn, isUnderdetermined, splitClauses } from '../shared/planner.ts'
import type { ToolSchema } from '../shared/tool-router.ts'

function tool(name: string, description: string): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object' } } }
}

const TOOLS: ToolSchema[] = [
  tool('battery_status', 'Read the battery percentage and charging state.'),
  tool('system_status', 'Report CPU, memory, disk and battery for this machine.'),
  tool('clipboard_read', 'Read the current clipboard text.'),
  tool('list_apps', 'List installed applications.'),
  tool('find_files', 'Find files by name on this Mac.'),
  tool('now_playing', 'Report what Spotify is playing right now.'),
  tool('music_taste', 'Read the local Spotify play history and playlists.'),
  tool('browser_open', 'Open a URL in the browser and return its readable text.'),
  tool('web_read', 'Read a public web page and return its text.'),
  tool('research', 'Research a question across multiple sources.'),
  tool('clipboard_write', 'Write text to the clipboard.')
]

test('an ordinary question becomes one actionable step and an answer', () => {
  const plan = planForTurn("What's my battery at?", TOOLS, [])
  assert.equal(plan.source, 'heuristic')
  assert.equal(plan.steps[0].tool, 'battery_status')
  assert.equal(plan.steps[0].optional, undefined)
  assert.equal(plan.steps.at(-1)?.kind, 'answer')
})

test('a compound request keeps its independent reads', () => {
  const plan = planForTurn("What's my battery percentage and what's on my clipboard?", TOOLS, [])
  assert.deepEqual(
    plan.steps.filter((step) => step.kind !== 'answer').map((step) => step.tool),
    ['battery_status', 'clipboard_read']
  )
})

test('reading tools for the same need collapse into one step', () => {
  const plan = planForTurn(
    'Open example.com in the browser, read the heading, and tell me the page title.',
    TOOLS,
    []
  )
  const actions = plan.steps.filter((step) => step.kind !== 'answer')
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].accept, ['browser_open', 'browser_read', 'web_read', 'site_open'])
})

test('an underdetermined request allows one question instead of a forced tool', () => {
  assert.equal(isUnderdetermined('Handle my music.'), true)
  assert.equal(isUnderdetermined('Deal with that thing from yesterday.'), true)
  const vague = planForTurn('Deal with that thing from yesterday.', TOOLS, [])
  assert.equal(vague.allowQuestion, true)
  assert.equal(vague.steps[0].kind, 'clarify')
  assert.equal(vague.steps.some((step) => step.tool !== undefined), false)

  const loose = planForTurn('Handle my music.', TOOLS, [])
  assert.equal(loose.allowQuestion, true)
  assert.equal(loose.steps.every((step) => step.optional === true || step.kind === 'answer'), true)
})

test('a request for sources carries a citation requirement', () => {
  const plan = planForTurn(
    'Research the current state of local LLM runtimes for a 16 GB Mac. Give at least two sources with URLs.',
    TOOLS,
    []
  )
  assert.equal(plan.requireCitations, 2)
  assert.equal(plan.requireCitationHosts, 2)
  assert.equal(plan.steps[0].tool, 'research')
})

test('small talk gets an answer-only plan', () => {
  const plan = planForTurn('Say hello in one short sentence.', TOOLS, [])
  assert.deepEqual(plan.steps.map((step) => step.kind), ['answer'])
  assert.equal(plan.requireCitations, undefined)
})

test('clause splitting handles commas, semicolons and "then"', () => {
  assert.deepEqual(splitClauses('check the battery, then read the clipboard; answer'), [
    'check the battery',
    'read the clipboard',
    'answer'
  ])
})
