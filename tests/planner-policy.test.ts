import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planForTurn } from '../shared/planner.ts'
import { shortlistTools, type ToolSchema } from '../shared/tool-router.ts'

function tool(name: string, description: string): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object' } } }
}

const TOOLS: ToolSchema[] = [
  tool('research', 'Research a question across multiple sources and return them with URLs.'),
  tool('web_search', 'Search the public web for result titles, URLs and snippets.'),
  tool('web_read', 'Read a public web page and return its text.'),
  tool('now_playing', 'Report what Spotify is playing right now.'),
  tool('play_music', 'Play a track, album or playlist in Spotify.'),
  tool('system_status', 'Report CPU, memory, disk and battery for this machine.')
]

const answerOnly = (prompt: string): boolean => {
  const plan = planForTurn(prompt, TOOLS, [])
  return plan.steps.length === 1 && plan.steps[0].kind === 'answer'
}

test('a static facts question is answered without spending a research round', () => {
  // The suite already treats "the capital of France" this way; a playwright's
  // name is the same kind of knowledge and should not cost a minute.
  assert.equal(answerOnly('Who wrote Hamlet?'), true)
  assert.equal(answerOnly('What is the capital of France?'), true)
})

test('asking about the credits of a song still looks it up', () => {
  const plan = planForTurn('Who wrote the song Dynamite by BTS?', TOOLS, [])
  assert.ok(
    plan.steps.some((step) => step.tool === 'research' || step.accept?.includes('research')),
    `expected a research step, got ${plan.steps.map((step) => step.kind).join(' → ')}`
  )
})

test('lyrics and translation still need the web, and a current result always does', () => {
  assert.equal(answerOnly('Find the English lyrics translation of this song'), false)
  assert.equal(answerOnly('Who won the election last night?'), false)
})

test('the shortlist answers "what am I listening to" with now_playing', () => {
  const wide = [
    ...TOOLS,
    ...Array.from({ length: 14 }, (_, index) => tool(`extra_${index}`, 'An unrelated local capability.'))
  ]
  const picked = shortlistTools('what am I listening to', wide, 8).map((entry) => entry.function.name)
  assert.ok(picked.includes('now_playing'), `got ${picked.join(',')}`)
})

test('"find my latest screenshot" reaches the file search, not only a new capture', () => {
  const wide = [
    ...TOOLS,
    tool('take_screenshot', 'Capture the screen to ~/Pictures/Lux and return the file path.'),
    tool('find_files', 'Search this Mac for files by name using Spotlight.'),
    tool('quick_look', 'Open a file in Quick Look.')
  ]
  const picked = shortlistTools('find my latest screenshot', wide, 8).map((entry) => entry.function.name)
  assert.ok(picked.includes('find_files'), `got ${picked.join(',')}`)
})
