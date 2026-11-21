import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractExcerpt } from '../electron/main/research.ts'
import { normalizeSearchQuery } from '../electron/main/web/search.ts'

const PAGE = [
  'Navigation Home Products Pricing Contact Sign in',
  'This page is mostly chrome and does not discuss the question at all, which is why it should not be chosen.',
  'Local AI agents run on a laptop by using quantised models and a small context. The runtime matters because memory bandwidth is the limit.',
  'Benchmarks show that a 7B model at four bits can answer simple tool calls on an M4 with sixteen gigabytes, while larger models swap.',
  'Copyright 2026 Example Corp. All rights reserved. Privacy policy.'
].join('\n')

test('extraction chooses paragraphs that discuss the question', () => {
  const excerpt = extractExcerpt(PAGE, 'local AI agents M4 memory benchmark', 600)
  assert.match(excerpt, /quantised models/)
  assert.match(excerpt, /M4/)
  assert.doesNotMatch(excerpt, /Privacy policy/)
})

test('a question is turned into a query about its subject', () => {
  assert.equal(normalizeSearchQuery('who wrote the song Dynamite by BTS'), 'song Dynamite by BTS')
  assert.equal(normalizeSearchQuery('please find me the weather in Boston'), 'weather in Boston')
  assert.equal(normalizeSearchQuery('Dynamite BTS lyrics'), 'Dynamite BTS lyrics')
})

test('extraction keeps a bounded result and falls back for short pages', () => {
  const excerpt = extractExcerpt(PAGE, 'local AI agents', 120)
  assert.ok(excerpt.length <= 120)
  assert.equal(extractExcerpt('short page', 'anything', 100), 'short page')
})
