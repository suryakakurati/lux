/**
 * Argument validation for model-proposed tool calls.
 *
 * Local models regularly emit `"50"` where a number is expected, or omit a
 * field. We coerce what is safe to coerce and reject the rest with a message the
 * model can read and correct on the next step of the loop — no silent failures.
 */
export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean'
  description?: string
  enum?: string[]
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface ToolParams {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
}

export interface ValidationResult {
  ok: boolean
  args: Record<string, unknown>
  error?: string
}

export function validateArgs(params: ToolParams, raw: unknown): ValidationResult {
  if (raw === null || raw === undefined) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, args: {}, error: 'Arguments must be a JSON object.' }
  }

  const input = raw as Record<string, unknown>
  const args: Record<string, unknown> = {}
  const unknownKeys = Object.keys(input).filter((key) => !(key in params.properties))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      args: {},
      error: `Unknown argument(s): ${unknownKeys.join(', ')}. Allowed: ${Object.keys(params.properties).join(', ') || 'none'}.`
    }
  }

  for (const [name, spec] of Object.entries(params.properties)) {
    const present = Object.prototype.hasOwnProperty.call(input, name)
    const value = input[name]

    if (!present || value === null || value === '') {
      const required = params.required?.includes(name) ?? false
      if (required) return { ok: false, args: {}, error: `Missing required argument "${name}".` }
      if (spec.default !== undefined) args[name] = spec.default
      continue
    }

    const coerced = coerce(value, spec)
    if (coerced.error) return { ok: false, args: {}, error: `Argument "${name}": ${coerced.error}` }
    if (spec.enum && !spec.enum.includes(String(coerced.value))) {
      return { ok: false, args: {}, error: `Argument "${name}" must be one of: ${spec.enum.join(', ')}.` }
    }
    if (typeof coerced.value === 'number') {
      const n = coerced.value
      if (spec.minimum !== undefined && n < spec.minimum) {
        return { ok: false, args: {}, error: `Argument "${name}" must be >= ${spec.minimum}.` }
      }
      if (spec.maximum !== undefined && n > spec.maximum) {
        return { ok: false, args: {}, error: `Argument "${name}" must be <= ${spec.maximum}.` }
      }
    }
    args[name] = coerced.value
  }

  return { ok: true, args }
}

function coerce(value: unknown, spec: JsonSchemaProperty): { value?: unknown; error?: string } {
  switch (spec.type) {
    case 'string':
      if (typeof value === 'string') return { value: value.trim() }
      if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) }
      if (Array.isArray(value)) return { value: value.join(', ') }
      return { error: 'expected a string.' }
    case 'boolean':
      if (typeof value === 'boolean') return { value }
      if (value === 'true' || value === 'yes' || value === 1) return { value: true }
      if (value === 'false' || value === 'no' || value === 0) return { value: false }
      return { error: 'expected true or false.' }
    case 'integer':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.+-]/g, ''))
      if (!Number.isFinite(n)) return { error: 'expected a number.' }
      if (spec.type === 'integer' && !Number.isInteger(n)) return { value: Math.round(n) }
      return { value: n }
    }
    default:
      return { value }
  }
}
