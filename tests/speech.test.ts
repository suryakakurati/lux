import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseVoice, firstSpokenSentence, paceSentences, speechText } from '../shared/speech.ts'

test('the first complete, useful sentence is spoken before the rest arrives', () => {
  assert.equal(
    firstSpokenSentence('Sure. The battery is at **64%** and charging.'),
    'The battery is at 64% and charging.'
  )
  assert.equal(firstSpokenSentence('Hello! How are you today?'), 'How are you today?')
})

test('markdown and URLs are read as words, not punctuation', () => {
  assert.equal(
    speechText('See [the docs](https://example.com/x) for **more**. 👋'),
    'See the docs for more.'
  )
  assert.equal(speechText('Open https://example.com now.'), 'Open the link now.')
})

test('sentences are paced instead of run together', () => {
  assert.equal(
    paceSentences('It is done. The file is open.'),
    'It is done. [[slnc 150]] The file is open.'
  )
})

test('a downloaded Premium voice is preferred over a compact one', () => {
  const voices = [
    { name: 'Samantha', language: 'en_US', quality: 'standard' as const },
    { name: 'Daniel', language: 'en_GB', quality: 'enhanced' as const },
    { name: 'Ava (Premium)', language: 'en_US', quality: 'premium' as const },
    { name: 'Tara', language: 'en_IN', quality: 'premium' as const }
  ]
  assert.equal(chooseVoice(voices), 'Ava (Premium)')
  assert.equal(chooseVoice(voices.slice(0, 2)), 'Daniel')
  assert.equal(chooseVoice(voices.slice(0, 1)), 'Samantha')
  assert.equal(chooseVoice([]), null)
})

test('an incomplete sentence is not spoken', () => {
  assert.equal(firstSpokenSentence('The battery is at 64'), null)
  assert.equal(firstSpokenSentence('Sure.'), null)
  assert.equal(firstSpokenSentence(''), null)
})
