import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aggregateBenchRuns,
  benchCitationCounts,
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

test('a research task needs real URLs that the tools actually returned', () => {
  const research: BenchTask = {
    id: 'research',
    category: 'research',
    prompt: 'research it',
    expectedToolsAny: ['research'],
    requiredCitations: 2,
    requiredCitationHosts: 2
  }
  const evidenceUrls = ['https://a.example/x', 'https://b.example/y']
  const ok = checkBenchTask(research, {
    text: 'Both agree ([1] https://a.example/x, [2] https://b.example/y).',
    toolNames: ['research'],
    evidenceUrls,
    rounds: 3,
    incomplete: false
  })
  assert.equal(ok, null)

  assert.match(
    checkBenchTask(research, {
      text: 'Both agree ([1] https://a.example/x).',
      toolNames: ['research'],
      evidenceUrls,
      rounds: 3,
      incomplete: false
    }) ?? '',
    /only 1\/2/
  )
  assert.match(
    checkBenchTask(research, {
      text: 'Both agree ([1] https://a.example/x, [2] https://invented.example/z).',
      toolNames: ['research'],
      evidenceUrls,
      rounds: 3,
      incomplete: false
    }) ?? '',
    /never returned/
  )
  assert.match(
    checkBenchTask(research, {
      text: 'Both agree.',
      toolNames: ['research'],
      evidenceUrls,
      rounds: 3,
      incomplete: false
    }) ?? '',
    /no source URL/
  )
})

test('citation counts used by the report come from the same rules', () => {
  const counts = benchCitationCounts('See https://a.example/x and https://made-up.example/z.', [
    'https://a.example/x'
  ])
  assert.equal(counts.backed, 1)
  assert.equal(counts.unbacked, 1)
  assert.deepEqual(counts.cited, ['a.example/x', 'made-up.example/z'])
})

test('repeated runs reduce to per-task medians and a strict pass rate', () => {
  const aggregate = aggregateBenchRuns([
    [
      result({ id: 'a', wallMs: 1_000, success: true }),
      result({ id: 'b', wallMs: 3_000, success: true })
    ],
    [
      result({ id: 'a', wallMs: 2_000, success: true }),
      result({ id: 'b', wallMs: 1_000, success: false, failureReason: 'missing tools' })
    ]
  ])
  assert.equal(aggregate.runs, 2)
  assert.equal(aggregate.tasks.length, 2)
  const a = aggregate.tasks.find((task) => task.id === 'a')
  const b = aggregate.tasks.find((task) => task.id === 'b')
  assert.equal(a?.wallMs, 1_500)
  assert.equal(a?.passRate, 100)
  assert.equal(a?.success, true)
  assert.equal(b?.passRate, 50)
  assert.equal(b?.success, false)
  assert.equal(b?.flaky, true)
  assert.deepEqual(b?.failureReasons, ['missing tools'])
  assert.equal(aggregate.summary.successes, 1)
  assert.equal(aggregate.summary.failures, 1)
  // Medians of the per-task medians: a=1500ms, b=2000ms → 1750ms.
  assert.equal(aggregate.summary.medianWallMs, 1_750)
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

test('summary keeps trivial and research medians separate', () => {
  const summary = summariseBench([
    result({ id: 'fast', category: 'trivial', wallMs: 1_000, toolCalls: [] }),
    result({ id: 'fast2', category: 'trivial', wallMs: 3_000, toolCalls: [] }),
    result({ id: 'slow', category: 'research', wallMs: 90_000 }),
    result({ id: 'slow2', category: 'research', wallMs: 110_000 })
  ])
  assert.equal(summary.medianTrivialWallMs, 2_000)
  assert.equal(summary.medianResearchWallMs, 100_000)
  assert.equal(summary.medianOneToolWallMs, undefined)
})
