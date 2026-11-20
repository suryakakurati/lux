import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkBenchTask,
  median,
  summariseBench,
  type BenchTask,
  type BenchTurnResult
} from '../shared/bench.ts'

const task: BenchTask = {
  id: 'example',
  category: 'multi-tool',
  prompt: 'do the thing',
  expectedToolsAll: ['one', 'two'],
  replyPattern: /done/i,
  replyMaxChars: 40
}

const result = (overrides: Partial<BenchTurnResult> = {}): BenchTurnResult => ({
  id: 'example',
  category: 'multi-tool',
  prompt: 'do the thing',
  wallMs: 1_000,
  ttftMs: 400,
  ttfswMs: 1_000,
  promptTokens: 100,
  evalTokens: 20,
  cachedPromptTokens: 50,
  cacheReusePct: 50,
  rounds: 2,
  toolRounds: 1,
  toolCalls: [
    { name: 'one', status: 'ok' },
    { name: 'two', status: 'ok' }
  ],
  success: true,
  text: 'done',
  replyChars: 4,
  ...overrides
})

test('median handles odd, even and empty samples', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([]), undefined)
})

test('task checks require every expected tool and the reply pattern', () => {
  assert.equal(
    checkBenchTask(task, { text: 'done', toolNames: ['one', 'two'], rounds: 2, incomplete: false }),
    null
  )
  assert.match(
    checkBenchTask(task, { text: 'done', toolNames: ['one'], rounds: 2, incomplete: false }) ?? '',
    /missing tools/
  )
  assert.match(
    checkBenchTask(task, { text: 'nope', toolNames: ['one', 'two'], rounds: 2, incomplete: false }) ?? '',
    /did not match/
  )
  assert.match(
    checkBenchTask(task, { text: 'done', toolNames: ['one', 'two'], rounds: 2, incomplete: true }) ?? '',
    /incomplete/
  )
})

test('forbidden tools and tool limits fail even with a good answer', () => {
  assert.match(
    checkBenchTask(
      { ...task, forbiddenTools: ['two'] },
      { text: 'done', toolNames: ['one', 'two'], rounds: 2, incomplete: false }
    ) ?? '',
    /forbidden tool/
  )
  assert.match(
    checkBenchTask(
      { ...task, maxTools: 1 },
      { text: 'done', toolNames: ['one', 'two'], rounds: 2, incomplete: false }
    ) ?? '',
    /used 2 tools/
  )
})

test('an ambiguous task may be resolved by one targeted question', () => {
  const ambiguous: BenchTask = {
    id: 'ambiguous',
    category: 'ambiguous',
    prompt: 'handle it',
    expectedToolsAny: ['read'],
    allowQuestionInsteadOfTools: true
  }
  assert.equal(
    checkBenchTask(ambiguous, {
      text: 'Which one do you mean?',
      toolNames: [],
      rounds: 1,
      incomplete: false
    }),
    null
  )
  assert.match(
    checkBenchTask(ambiguous, {
      text: 'All done.',
      toolNames: [],
      rounds: 1,
      incomplete: false
    }) ?? '',
    /missing any of/
  )
})

test('summary reports medians, totals and weighted cache reuse', () => {
  const summary = summariseBench([
    result({ id: 'a', wallMs: 1_000, ttftMs: 400, toolCalls: [{ name: 'one', status: 'ok' }, { name: 'two', status: 'ok' }] }),
    result({
      id: 'b',
      wallMs: 3_000,
      ttftMs: 600,
      promptTokens: 300,
      cachedPromptTokens: 150,
      toolCalls: [{ name: 'one', status: 'ok' }],
      success: false
    })
  ])
  assert.equal(summary.count, 2)
  assert.equal(summary.successes, 1)
  assert.equal(summary.failures, 1)
  assert.equal(summary.medianWallMs, 2_000)
  assert.equal(summary.medianTtftMs, 500)
  assert.equal(summary.multiToolTurns, 1)
  assert.equal(summary.medianMultiToolWallMs, 1_000)
  assert.equal(summary.promptTokens, 400)
  assert.equal(summary.cachedPromptTokens, 200)
  assert.equal(summary.cacheReusePct, 50)
})
