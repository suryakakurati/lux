import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheReusePercent } from '../shared/metrics.ts'

test('cache reuse is calculated from Ollama cached and total prompt counts', () => {
  assert.equal(cacheReusePercent(0, 1_000), 0)
  assert.equal(cacheReusePercent(250, 1_000), 25)
  assert.equal(cacheReusePercent(1_000, 1_000), 100)
})

test('cache reuse is clamped and omitted when counts are unavailable', () => {
  assert.equal(cacheReusePercent(1_500, 1_000), 100)
  assert.equal(cacheReusePercent(undefined, 1_000), undefined)
  assert.equal(cacheReusePercent(10, undefined), undefined)
  assert.equal(cacheReusePercent(10, 0), undefined)
})
