import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failureEnvelope, successEnvelope } from '../shared/tool-envelope.ts'

test('a successful envelope always carries the five stable fields', () => {
  const envelope = successEnvelope('42%', { nextHint: 'Answer from this.' })
  assert.deepEqual(Object.keys(envelope).sort(), ['data', 'next_hint', 'ok', 'truncated'])
  assert.equal(envelope.ok, true)
  assert.equal(envelope.data, '42%')
  assert.equal(envelope.truncated, false)
  assert.equal(envelope.next_hint, 'Answer from this.')
})

test('a failed envelope names the failure instead of asking the model to guess', () => {
  const envelope = failureEnvelope('timeout', 'tool stopped', 'Try a smaller request.')
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error_kind, 'timeout')
  assert.equal(envelope.next_hint, 'Try a smaller request.')
  assert.equal(envelope.truncated, false)
})
