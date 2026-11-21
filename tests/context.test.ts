import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contextBudgetChars,
  contextChars,
  fitContext,
  truncateToolResult,
  type ContextMessage
} from '../shared/context.ts'

test('large tool results are capped with an honest note', () => {
  const research = truncateToolResult('research', 'x'.repeat(10_000))
  assert.ok(research.length < 5_000)
  assert.match(research, /truncated 5500 characters/)
  assert.equal(truncateToolResult('clipboard_read', 'short'), 'short')
})

test('fitting drops the oldest complete tool batch first', () => {
  const messages: ContextMessage[] = [
    { role: 'system', content: 's'.repeat(1_000) },
    { role: 'user', content: 'request' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a' } }] },
    { role: 'tool', content: 'a'.repeat(10_000), tool_name: 'a' },
    { role: 'system', content: 'task state after a' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'b' } }] },
    { role: 'tool', content: 'b'.repeat(1_000), tool_name: 'b' }
  ]
  const fitted = fitContext(messages, 8_000)
  assert.ok(contextChars(fitted) <= 8_000)
  assert.equal(fitted.some((message) => message.tool_name === 'a'), false)
  assert.equal(fitted.some((message) => message.tool_name === 'b'), true)
  assert.equal(fitted[0].role, 'system')
  assert.equal(fitted[1].role, 'user')
})

test('a conversation inside the budget is returned unchanged', () => {
  const messages: ContextMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' }
  ]
  assert.equal(fitContext(messages, 10_000), messages)
})

test('the budget leaves output room inside the configured context', () => {
  const budget = contextBudgetChars(8_192, 1_536)
  assert.equal(budget, 17_305)
  assert.ok(contextBudgetChars(2_048, 1_536) >= 6_000)
})
