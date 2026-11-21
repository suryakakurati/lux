/**
 * The uniform result every tool call produces.
 *
 * `data` is the text the model sees. The other fields are deliberately small and
 * stable so the loop, the trace and the UI can make decisions without parsing
 * tool-specific prose: a failure has a kind, a truncated result says so, and a
 * hint tells the model what to do next.
 */

export type ToolErrorKind = 'unknown_tool' | 'invalid_args' | 'denied' | 'timeout' | 'failed'

export interface ToolEnvelope {
  ok: boolean
  data: string
  truncated: boolean
  next_hint?: string
  error_kind?: ToolErrorKind
}

export function successEnvelope(
  data: string,
  options: { truncated?: boolean; nextHint?: string } = {}
): ToolEnvelope {
  return {
    ok: true,
    data,
    truncated: options.truncated ?? false,
    ...(options.nextHint ? { next_hint: options.nextHint } : {})
  }
}

export function failureEnvelope(
  kind: ToolErrorKind,
  data: string,
  nextHint: string,
  options: { truncated?: boolean } = {}
): ToolEnvelope {
  return {
    ok: false,
    data,
    truncated: options.truncated ?? false,
    next_hint: nextHint,
    error_kind: kind
  }
}
