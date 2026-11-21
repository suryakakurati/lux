import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstSpokenSentence } from '../shared/speech.ts'

test('the first complete, useful sentence is spoken before the rest arrives', () => {
  assert.equal(
    firstSpokenSentence('Sure. The battery is at **64%** and charging.'),
    'The battery is at 64% and charging.'
  )
  assert.equal(firstSpokenSentence('Hello! How are you today?'), 'How are you today?')
})

test('an incomplete sentence is not spoken', () => {
  assert.equal(firstSpokenSentence('The battery is at 64'), null)
  assert.equal(firstSpokenSentence('Sure.'), null)
  assert.equal(firstSpokenSentence(''), null)
})
