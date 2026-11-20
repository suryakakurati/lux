import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TaskStateStore } from '../electron/main/agent/task-state.ts'

test('task state records the objective, steps, URLs and failures for the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lux-task-'))
  try {
    const store = new TaskStateStore(dir)
    const task = store.begin('Compare three local AI agent runtimes')
    task.tool(
      'web_read',
      true,
      'read runtime docs',
      'See https://example.com/runtime for details',
      { url: 'https://example.com/runtime' }
    )
    task.tool('browser_click', false, 'click missed', 'no matching link', {})
    task.note('The first source is older than the second.')
    const prompt = task.prompt()
    assert.match(prompt, /Compare three local AI agent runtimes/)
    assert.match(prompt, /https:\/\/example\.com\/runtime/)
    assert.match(prompt, /click missed/)
    assert.match(prompt, /older than the second/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an interrupted task is resumable and keeps its completed steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lux-task-'))
  try {
    const first = new TaskStateStore(dir)
    const task = first.begin('Find the assignment instructions')
    task.tool('vault_search', true, 'found two notes', 'notes/dijkstra.md', {})
    task.interrupt('model call failed')

    const second = new TaskStateStore(dir)
    const resumed = second.begin('Find the assignment instructions', 'Find the assignment instructions')
    assert.equal(resumed.id, task.id)
    assert.equal(resumed.resumed, true)
    assert.match(resumed.prompt(), /found two notes/)
    resumed.finish('done')

    const again = second.begin('Find the assignment instructions', 'Find the assignment instructions')
    assert.notEqual(again.id, task.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
