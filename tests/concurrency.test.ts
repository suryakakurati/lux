import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapLimit } from '../shared/concurrency.ts'

test('mapLimit preserves input order', async () => {
  const result = await mapLimit([3, 1, 2], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value * 5))
    return value * 10
  })
  assert.deepEqual(result, [30, 10, 20])
})

test('mapLimit never exceeds its ceiling', async () => {
  let active = 0
  let peak = 0
  await mapLimit([1, 2, 3, 4, 5, 6], 3, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
  })
  assert.equal(peak, 3)
})

test('mapLimit handles an empty list and a zero ceiling', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1), [])
  assert.deepEqual(await mapLimit([1, 2], 0, async (value) => value), [1, 2])
})
