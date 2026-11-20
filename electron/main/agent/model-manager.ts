import type { Settings } from '../../../shared/types'
import { logLine } from '../log'
import { systemStats } from '../mac/stats'

interface RunningModel {
  name: string
  size: number
  until: string
}

/**
 * Ollama model lifecycle for a 16 GB machine.
 *
 * Lux has exactly one working chat model. Embedding and specialist models are
 * optional and are never loaded as a side effect of an ordinary turn. The
 * manager keeps the primary model warm with the configured keep_alive, releases
 * models Lux itself no longer needs, and reports what is resident so a second
 * large model cannot quietly compete for unified memory.
 */
export class ModelManager {
  private prepared: { model: string; at: number } | null = null

  constructor(private readonly settings: () => Settings) {}

  /** Called once at startup, after settings are available. */
  async reconcile(): Promise<void> {
    try {
      const running = await this.running()
      if (running.length === 0) return
      const settings = this.settings()

      // Lexical recall needs no embedding model. If a previous run left one
      // resident, release it rather than carrying 370 MB through the session.
      if (settings.memoryMode === 'lexical') {
        const embedding = running.find((model) => model.name === settings.embeddingModel)
        if (embedding) await this.release(embedding.name, 'lexical memory needs no embeddings')
      }

      // A specialist is opt-in per task; it must not stay resident between turns.
      if (settings.specializedModel && settings.specializedModel !== settings.model) {
        const specialist = running.find((model) => model.name === settings.specializedModel)
        if (specialist) await this.release(specialist.name, 'specialist is not active')
      }

      logLine(
        'model',
        `resident: ${(await this.running()).map((model) => `${model.name} ${(model.size / 1e9).toFixed(1)}GB`).join(', ') || 'none'}`
      )
    } catch (error) {
      logLine('model', `reconcile skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Ensure a model swap does not leave the previous chat model resident.
   * The check is cached for a minute: it must not add an HTTP round trip to
   * every voice turn.
   */
  async prepare(model: string): Promise<void> {
    const now = Date.now()
    if (this.prepared?.model === model && now - this.prepared.at < 60_000) return
    const previous = this.prepared?.model ?? null
    this.prepared = { model, at: now }

    try {
      const running = await this.running()
      const old = this.lastChat && this.lastChat !== model ? this.lastChat : previous
      if (old && old !== model && running.some((entry) => entry.name === old)) {
        await this.release(old, 'replaced by the active model')
      }
      this.lastChat = model
    } catch {
      // A model that cannot be inspected still gets a normal chat request.
    }
  }

  private lastChat: string | null = null

  chatOptions(): { keepAlive: string; numCtx: number; numPredict: number } {
    const settings = this.settings()
    return {
      keepAlive: settings.keepModelLoaded ? settings.modelKeepAlive || '30m' : '0',
      numCtx: settings.contextWindow || 8_192,
      numPredict: settings.maxOutputTokens || 1_536
    }
  }

  async status(): Promise<RunningModel[]> {
    return this.running()
  }

  /**
   * One deliberate, bounded use of the configured specialist. This is the only
   * path that loads a second chat model, and it always releases it afterward.
   */
  async consult(question: string): Promise<{ text: string; model: string; ms: number }> {
    const settings = this.settings()
    const specialist = settings.specializedModel.trim()
    if (!specialist || specialist === settings.model) {
      throw new Error('No specialist model is configured. Use the primary model and the available tools.')
    }

    const stats = await systemStats().catch(() => null)
    if (stats && stats.memPercent >= 90) {
      throw new Error(
        `Memory is ${stats.memPercent}% full, so loading ${specialist} would compete with the active model. Continue with the primary model.`
      )
    }

    const started = Date.now()
    try {
      const response = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: specialist,
          messages: [
            {
              role: 'system',
              content:
                'You are a specialist consulted for one bounded reasoning problem. Be concrete and concise. Do not claim tools you cannot use.'
            },
            { role: 'user', content: question.slice(0, 12_000) }
          ],
          stream: false,
          keep_alive: '0',
          options: {
            num_ctx: settings.contextWindow || 8_192,
            num_predict: settings.maxOutputTokens || 1_536,
            temperature: 0.25
          }
        }),
        signal: AbortSignal.timeout(120_000)
      })
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`)
      const data = (await response.json()) as { message?: { content?: string } }
      const text = data.message?.content?.trim()
      if (!text) throw new Error('The specialist returned no text.')
      logLine('model', `specialist ${specialist} answered in ${Date.now() - started}ms`)
      return { text, model: specialist, ms: Date.now() - started }
    } finally {
      await this.release(specialist, 'specialist finished')
    }
  }

  private async running(): Promise<RunningModel[]> {
    const settings = this.settings()
    const response = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/ps`, {
      signal: AbortSignal.timeout(2_500)
    })
    if (!response.ok) return []
    const data = (await response.json()) as {
      models?: { name?: string; size_vram?: number; size?: number; expires_at?: string }[]
    }
    return (data.models ?? [])
      .filter((model) => Boolean(model.name))
      .map((model) => ({
        name: model.name ?? '',
        size: model.size_vram ?? model.size ?? 0,
        until: model.expires_at ?? ''
      }))
  }

  private async release(model: string, reason: string): Promise<void> {
    logLine('model', `unload ${model}: ${reason}`)
    try {
      await fetch(`${this.settings().ollamaUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0, stream: false }),
        signal: AbortSignal.timeout(5_000)
      })
    } catch (error) {
      logLine('model', `unload failed ${model}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
