/**
 * Ollama client.
 *
 * Shapes follow the native /api/chat contract: tool definitions use JSON Schema,
 * and tool calls come back with `arguments` as an object (streaming may deliver
 * them incrementally, so the agent merges by index).
 */

export interface OllamaToolCall {
  id?: string
  function: {
    index?: number
    name: string
    arguments: Record<string, unknown> | string
  }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OllamaToolCall[]
  tool_name?: string
  thinking?: string
}

export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface StreamChunk {
  content?: string
  thinking?: string
  toolCalls?: OllamaToolCall[]
  done?: boolean
  metrics?: ModelMetrics
}

/** Timing fields Ollama reports on the final streamed chunk, in milliseconds. */
export interface ModelMetrics {
  totalDurationMs?: number
  loadDurationMs?: number
  promptEvalCount?: number
  promptEvalCachedCount?: number
  promptEvalDurationMs?: number
  evalCount?: number
  evalDurationMs?: number
}

export interface SamplingOptions {
  temperature?: number
  topK?: number
  topP?: number
  seed?: number
  repeatPenalty?: number
}

export interface ChatOptions {
  url: string
  model: string
  messages: OllamaMessage[]
  tools?: OllamaTool[]
  keepAlive?: string
  numCtx?: number
  numPredict?: number
  /** Deterministic decoding for measurements; the app leaves this unset. */
  sampling?: SamplingOptions
  signal?: AbortSignal
}

export async function streamChat(options: ChatOptions): Promise<AsyncGenerator<StreamChunk>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let response: Response
  try {
    response = await fetch(`${options.url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        tools: options.tools,
        think: false,
        stream: true,
        keep_alive: options.keepAlive ?? '30m',
        options: {
          temperature: options.sampling?.temperature ?? 0.35,
          num_ctx: options.numCtx ?? 24_576,
          num_predict: options.numPredict ?? 4_096,
          ...(options.sampling?.topK !== undefined ? { top_k: options.sampling.topK } : {}),
          ...(options.sampling?.topP !== undefined ? { top_p: options.sampling.topP } : {}),
          ...(options.sampling?.seed !== undefined ? { seed: options.sampling.seed } : {}),
          ...(options.sampling?.repeatPenalty !== undefined
            ? { repeat_penalty: options.sampling.repeatPenalty }
            : {})
        }
      }),
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timeout)
    if (options.signal?.aborted) {
      const cancelled = new Error('cancelled')
      cancelled.name = 'AbortError'
      throw cancelled
    }
    throw new Error(explainFetchError(error, options.url), { cause: error })
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    clearTimeout(timeout)
    throw new Error(`Ollama returned ${response.status}. ${detail.slice(0, 400)}`)
  }

  return parseLines(response.body, () => clearTimeout(timeout))
}

async function* parseLines(
  body: ReadableStream<Uint8Array>,
  onDone: () => void
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        const chunk = parseChunk(line)
        if (chunk) yield chunk
      }
    }
    const tail = buffer.trim()
    if (tail) {
      const chunk = parseChunk(tail)
      if (chunk) yield chunk
    }
  } finally {
    onDone()
    reader.releaseLock()
  }
}

function parseChunk(line: string): StreamChunk | null {
  let json: {
    message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }
    done?: boolean
    error?: string
    total_duration?: number
    load_duration?: number
    prompt_eval_count?: number
    prompt_eval_cached_count?: number
    prompt_eval_duration?: number
    eval_count?: number
    eval_duration?: number
  }
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  if (json.error) throw new Error(json.error)
  return {
    content: json.message?.content,
    thinking: json.message?.thinking,
    toolCalls: json.message?.tool_calls,
    done: json.done,
    metrics: json.done
      ? {
          totalDurationMs: toMs(json.total_duration),
          loadDurationMs: toMs(json.load_duration),
          promptEvalCount: json.prompt_eval_count,
          promptEvalCachedCount: json.prompt_eval_cached_count,
          promptEvalDurationMs: toMs(json.prompt_eval_duration),
          evalCount: json.eval_count,
          evalDurationMs: toMs(json.eval_duration)
        }
      : undefined
  }
}

function toMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 1_000_000) : undefined
}

export async function listModels(url: string): Promise<string[]> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3_000)
    })
    if (!response.ok) return []
    const data = (await response.json()) as { models?: { name: string }[] }
    return (data.models ?? []).map((model) => model.name).sort()
  } catch {
    return []
  }
}

export async function ping(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(1_500)
    })
    return response.ok
  } catch {
    return false
  }
}

/** /api/embed returns L2-normalised vectors for the given input strings. */
export async function embed(url: string, model: string, input: string[]): Promise<number[][]> {
  const response = await fetch(`${url.replace(/\/$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, keep_alive: '10m' }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Embedding failed (${response.status})`)
  const data = (await response.json()) as { embeddings?: number[][] }
  return data.embeddings ?? []
}

function explainFetchError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('abort')) return 'The model took too long to respond.'
  return `Can't reach Ollama at ${url}. Is it running? (${message})`
}
