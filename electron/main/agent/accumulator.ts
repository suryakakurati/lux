import type { OllamaToolCall } from './ollama'

/** A tool call after streaming fragments have been stitched together. */
export interface ResolvedCall {
  name: string
  args: Record<string, unknown>
}

/**
 * Streaming tool calls arrive in fragments: the name may appear once, arguments
 * may be a partial object or a partial JSON string. Normalise both shapes here so
 * the loop only ever sees complete calls.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<
    number,
    { name: string; raw: string; args: Record<string, unknown> | null }
  >()
  private readonly mirror: OllamaToolCall[] = []

  add(calls: OllamaToolCall[]): void {
    for (const call of calls) {
      const index = call.function?.index ?? this.slots.size
      const existing =
        this.slots.get(index) ?? { name: '', raw: '', args: null as Record<string, unknown> | null }
      if (call.function?.name) existing.name = call.function.name
      const args = call.function?.arguments
      if (typeof args === 'string') existing.raw += args
      else if (args && typeof args === 'object') existing.args = args
      this.slots.set(index, existing)
      this.mirror.push(call)
    }
  }

  finish(): ResolvedCall[] {
    const calls: ResolvedCall[] = []
    for (const slot of this.slots.values()) {
      if (!slot.name) continue
      let args: Record<string, unknown> = slot.args ?? {}
      if (slot.raw.trim()) {
        try {
          const parsed = JSON.parse(completeJson(slot.raw))
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
        } catch {
          args = slot.args ?? {}
        }
      }
      calls.push({ name: slot.name, args })
    }
    return calls
  }

  raw(): OllamaToolCall[] {
    return this.mirror
  }
}

/** Repair the most common streaming JSON truncation: a missing closing brace. */
export function completeJson(raw: string): string {
  let text = raw.trim()
  if (!text.startsWith('{')) {
    const start = text.indexOf('{')
    if (start === -1) return '{}'
    text = text.slice(start)
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (const char of text) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') inString = !inString
    else if (!inString && char === '{') depth += 1
    else if (!inString && char === '}') depth -= 1
  }
  if (inString) text += '"'
  while (depth > 0) {
    text += '}'
    depth -= 1
  }
  return text
}
