import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldOpenChat } from '../shared/router.ts'

test('short spoken confirmation stays in the HUD', () => {
  assert.equal(
    shouldOpenChat({ text: 'Opened Spotify.', hadTools: true, threshold: 220, userAskedToShow: false }),
    false
  )
})

test('a long answer opens the chat window', () => {
  const text = 'Here is the breakdown. '.repeat(20)
  assert.equal(shouldOpenChat({ text, hadTools: false, threshold: 220, userAskedToShow: false }), true)
})

test('lists and code fences open the chat window', () => {
  assert.equal(
    shouldOpenChat({ text: 'Steps:\n- one\n- two', hadTools: false, threshold: 220, userAskedToShow: false }),
    true
  )
  assert.equal(
    shouldOpenChat({ text: '```\nnpm run dev\n```', hadTools: false, threshold: 220, userAskedToShow: false }),
    true
  )
})

test('a tool that asks for the chat surface wins over brevity', () => {
  assert.equal(
    shouldOpenChat({ text: 'Done.', hadTools: true, threshold: 220, userAskedToShow: true }),
    true
  )
})

test('empty answer after a tool still routes to the HUD', () => {
  assert.equal(shouldOpenChat({ text: '', hadTools: true, threshold: 220, userAskedToShow: false }), true)
  assert.equal(shouldOpenChat({ text: '', hadTools: false, threshold: 220, userAskedToShow: false }), false)
})
