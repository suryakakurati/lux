import type { ToolParams } from '../../../shared/validate'
import type { ToolEnvelope, ToolErrorKind } from '../../../shared/tool-envelope'
import type { OllamaTool } from '../agent/ollama'

export type { ToolErrorKind }

export interface ToolContext {
  commitments: import('../commitments').CommitmentLedger
  /** Run another tool from a background job. Omitted by isolated harnesses. */
  runTool?: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>
  confirm(request: { tool: string; args: Record<string, unknown>; reason: string }): Promise<boolean>
  notify(title: string, body: string): void
  speak(text: string): void
  remember(fact: string): void
  settings: import('../../../shared/types').Settings
  /** Present in the app; omitted by isolated audit/smoke harnesses. */
  models?: import('../agent/model-manager').ModelManager
  /** The turn's signal. A cancelled turn or a tool timeout aborts the work. */
  signal?: AbortSignal
}

export interface ToolResult {
  /** Text handed back to the model. */
  content: string
  /** One short human-readable line for the HUD/activity row. */
  summary: string
  /** Force the chat window open when this result deserves reading. */
  openChat?: boolean
  /**
   * A non-ok result produced without throwing. A refused or invalid request is
   * not evidence that the action happened, so the loop must not see `ok: true`
   * for it; the envelope is built from this kind instead.
   */
  fail?: ToolErrorKind
}

export interface ToolDef {
  name: string
  description: string
  /** `confirm` tools pause and ask the person before running. */
  risk: 'safe' | 'confirm'
  params: ToolParams
  /** Independent, read-only calls can run together in one agent round. */
  parallelSafe?: boolean
  /** Hard limit for one call; a hung tool must not freeze the turn. */
  timeoutMs?: number
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

export type { ToolParams }

export interface ToolCallOutcome extends ToolEnvelope {
  summary: string
  durationMs: number
  openChat?: boolean
  denied?: boolean
}

/** Convert our definitions into Ollama's function-calling schema. */
export function toOllamaTools(defs: ToolDef[]): OllamaTool[] {
  return defs.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.params as unknown as Record<string, unknown>
    }
  }))
}
