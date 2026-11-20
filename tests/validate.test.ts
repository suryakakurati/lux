import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateArgs, type ToolParams } from '../shared/validate.ts'

const params: ToolParams = {
  type: 'object',
  properties: {
    level: { type: 'integer', minimum: 0, maximum: 100 },
    name: { type: 'string' },
    mode: { type: 'string', enum: ['full', 'selection'] },
    append: { type: 'boolean', default: true },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 }
  },
  required: ['level']
}

test('coerces numeric strings from local models', () => {
  const result = validateArgs(params, { level: '62' })
  assert.equal(result.ok, true)
  assert.equal(result.args.level, 62)
})

test('applies defaults and trims strings', () => {
  const result = validateArgs(params, { level: 10, name: '  Spotify  ' })
  assert.equal(result.ok, true)
  assert.equal(result.args.name, 'Spotify')
  assert.equal(result.args.append, true)
  assert.equal(result.args.limit, 8)
})

test('rejects missing required arguments', () => {
  const result = validateArgs(params, { name: 'Spotify' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /level/)
})

test('rejects out-of-range and enum violations', () => {
  assert.equal(validateArgs(params, { level: 400 }).ok, false)
  assert.equal(validateArgs(params, { level: 20, mode: 'window' }).ok, false)
})

test('rejects unknown arguments instead of silently dropping them', () => {
  const result = validateArgs(params, { level: 20, colour: 'red' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /colour/)
})
