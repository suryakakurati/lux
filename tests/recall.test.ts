import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lexicalScore, rankMemories, recallTerms } from '../shared/recall.ts'

test('recall terms drop filler and singularise plurals', () => {
  assert.deepEqual(recallTerms('What were the local AI agents doing?'), ['local', 'agent'])
})

test('a relevant exchange outscores an unrelated one', () => {
  const relevant = lexicalScore('local ai agents', 'I compared three local AI agent runtimes')
  const unrelated = lexicalScore('local ai agents', 'the weather in Orlando is warm')
  assert.ok(relevant > unrelated)
  assert.equal(lexicalScore('local ai agents', 'nothing related here'), 0)
})

test('ranked memories prefer overlap and break ties by recency', () => {
  const now = Date.now()
  const ranked = rankMemories(
    [
      { text: 'quarterly budget spreadsheet', at: now - 86_400_000 },
      { text: 'quarterly budget spreadsheet', at: now },
      { text: 'Spotify playlist for focus', at: now }
    ],
    'budget spreadsheet',
    2
  )
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0].entry.at, now)
})

test('an empty query recalls nothing rather than everything', () => {
  assert.equal(
    rankMemories([{ text: 'anything at all', at: Date.now() }], 'the and for', 4).length,
    0
  )
})
