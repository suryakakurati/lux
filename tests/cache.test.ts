import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TtlCache } from '../electron/main/web/cache.ts'

test('a cache entry expires instead of serving stale data', () => {
  const cache = new TtlCache<string>(4)
  cache.set('page', 'body', 100, 1_000)
  assert.equal(cache.get('page', 1_050), 'body')
  assert.equal(cache.get('page', 1_100), undefined)
  assert.equal(cache.size, 0)
})

test('the cache evicts its oldest entry at the ceiling', () => {
  const cache = new TtlCache<number>(2)
  cache.set('a', 1, 1_000, 0)
  cache.set('b', 2, 1_000, 0)
  cache.set('c', 3, 1_000, 0)
  assert.equal(cache.get('a', 0), undefined)
  assert.equal(cache.get('b', 0), 2)
  assert.equal(cache.get('c', 0), 3)
})

test('clear removes every entry', () => {
  const cache = new TtlCache<number>(2)
  cache.set('a', 1, 1_000)
  cache.clear()
  assert.equal(cache.size, 0)
})
