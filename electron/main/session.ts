import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  Bootstrap,
  ChatItem,
  ConfirmRequest,
  ConversationSummary,
  LuxEvent,
  Settings,
  SystemStats,
  ToolRun
} from '../../shared/types'
import type { Brief } from '../../shared/commitments'
import { shouldOpenChat } from '../../shared/router'
import type { CommitmentLedger } from './commitments'
import { runAgent } from './agent/agent'
import type { Memory } from './agent/memory'
import type { ModelManager } from './agent/model-manager'
import { TaskStateStore } from './agent/task-state'
import { isObsoleteRefusal, needsMusicTaste, needsSiteCheck } from './agent/refusals'
import { logLine } from './log'
import type { OllamaMessage } from './agent/ollama'
import type { Transcriber } from './stt'
import { Store } from './store'
import type { ToolContext } from './tools/types'
import { executeTool } from './tools'
import { batteryInfo, frontmostApp, outputVolume, runningApps, systemStats } from './mac/stats'

interface StoredConversation {
  id: string
  title: string
  updatedAt: number
  items: ChatItem[]
}

interface ConversationFile {
  active: string
  list: StoredConversation[]
}

export interface SessionDeps {
  dataDir: string
  settings: () => Settings
  commitments: CommitmentLedger
  models: ModelManager
  memory: Memory
  transcriber: Transcriber
  broadcast: (event: LuxEvent) => void
  showChat: () => void
  showHud: () => void
  hideHud: () => void
  speak: (text: string) => void
  stopSpeaking?: () => void
  notify: (title: string, body: string) => void
  /** Start Ollama if a long sleep stopped it; false means it is still down. */
  ensureEngine: () => Promise<boolean>
}

interface MachineContext {
  runningApps: string[]
  battery: { percent: number | null; charging: boolean; onAc: boolean }
  volume: number
  frontmostApp?: string
}

/** "Play this", "put on those", "queue it up" — playback, not taste. */
const playIntent = /\b(play|put on|queue|start|shuffle|resume|listen to)\b/i

const MAX_ITEMS = 400
const MAX_CONVERSATIONS = 40
const HUD_LINGER_MS = 2_400

/**
 * The assistant's working memory for a conversation plus the turn pipeline:
 * transcribe → reason → act → route the result to the HUD or the chat window.
 */
export class Session {
  private store: Store<ConversationFile>
  private file: ConversationFile
  private items: ChatItem[] = []
  private conversationId = ''
  private controller: AbortController | null = null
  private running = false
  /** True from the start of a hold until its transcription/turn has finished. */
  private voiceActive = false
  /** Work the last turn could not finish; handed back to the next one. */
  private openTask: string | null = null
  private confirmResolvers = new Map<string, (approved: boolean) => void>()
  private hudTimer: NodeJS.Timeout | null = null
  private cachedStats: SystemStats | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private readonly tasks: TaskStateStore
  private machineCache: { at: number; value: MachineContext } | null = null

  constructor(private readonly deps: SessionDeps) {
    this.store = new Store<ConversationFile>(join(deps.dataDir, 'conversations.json'), {
      active: '',
      list: []
    })
    this.file = this.store.read()
    this.tasks = new TaskStateStore(deps.dataDir)
    if (!Array.isArray(this.file.list)) this.file.list = []
    const active = this.file.list.find((conversation) => conversation.id === this.file.active)
    if (active) {
      this.conversationId = active.id
      this.items = active.items ?? []
    } else {
      this.startNewConversation(false)
    }
  }

  // ---------------------------------------------------------------- lifecycle

  bootstrap(): Omit<Bootstrap, 'engine'> {
    return {
      items: this.items,
      settings: this.deps.settings(),
      stats: this.cachedStats ?? emptyStats(),
      permissions: { microphone: 'unknown', inputMonitoring: false, automation: 'unknown', hotkeyBinary: false },
      model: this.deps.settings().model,
      ollamaReachable: false,
      conversations: this.summaries(),
      activeConversationId: this.conversationId
    }
  }

  startStatsLoop(onStats: (stats: SystemStats) => void): void {
    const tick = async (): Promise<void> => {
      try {
        const next = await systemStats()
        this.cachedStats = next
        onStats(next)
      } catch {
        /* telemetry is best-effort */
      }
    }
    void tick()
    this.statsTimer = setInterval(() => void tick(), 4_000)
  }

  stopStatsLoop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  currentStats(): SystemStats {
    return this.cachedStats ?? emptyStats()
  }

  summaries(): ConversationSummary[] {
    return [...this.file.list]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  // ------------------------------------------------------------------- voice

  beginListening(): void {
    // A new voice turn is an interruption: stop the old generation and any
    // speech that is still playing before opening the microphone.
    if (this.running) this.cancel()
    this.deps.stopSpeaking?.()
    this.voiceActive = true
    this.clearHudTimer()
    this.deps.showHud()
    this.deps.broadcast({ kind: 'hud', state: 'listening' })
  }

  endListening(): void {
    this.deps.broadcast({ kind: 'hud', state: 'transcribing' })
  }

  async handleAudio(wav: Buffer): Promise<void> {
    try {
      const result = await this.deps.transcriber.transcribe(wav)
      if (!result.text) {
        this.deps.broadcast({
          kind: 'hud',
          state: 'error',
          detail: 'Didn’t catch that — try again.'
        })
        this.scheduleHide()
        return
      }
      this.deps.broadcast({ kind: 'hud', state: 'thinking', transcript: result.text })
      await this.turn(result.text, 'voice')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.broadcast({ kind: 'hud', state: 'error', detail: message.slice(0, 160) })
      this.appendSystem(`Speech recognition failed: ${message}`)
      this.scheduleHide()
    } finally {
      this.voiceActive = false
    }
  }

  isBusy(): boolean {
    return this.running || this.voiceActive
  }

  /** No audio ever reached transcription, so the voice hold is over. */
  clearVoiceActivity(): void {
    this.voiceActive = false
  }

  /**
   * Compose and surface the morning brief without invoking the model.
   * Returns null rather than interrupting a turn that is already running.
   */
  deliverBrief(): Brief | null {
    if (this.isBusy()) return null
    const brief = this.deps.commitments.brief()
    const item: ChatItem = {
      id: randomUUID(),
      kind: 'assistant',
      text: brief.text,
      at: Date.now()
    }
    this.items.push(item)
    this.trim()
    this.deps.broadcast({ kind: 'history', items: this.items })

    const firstBullet = brief.text
      .split('\n')
      .find((line) => line.startsWith('•'))
      ?.replace(/^•\s*/, '')
    const detail =
      brief.summary === 'clear day'
        ? 'The ledger is clear. Nothing is due today.'
        : `${brief.summary}${firstBullet ? ` — ${firstBullet}` : ''}`

    this.deps.showHud()
    this.deps.broadcast({ kind: 'hud', state: 'brief', detail })
    this.deps.notify('Lux · morning brief', brief.text)
    this.scheduleHide(9_000)
    this.persist()
    logLine('brief', `${JSON.stringify(brief.summary)} ${brief.text.length} chars`)
    return brief
  }

  cancel(): void {
    if (this.confirmResolvers.size > 0) {
      for (const [id, resolve] of this.confirmResolvers) {
        resolve(false)
        this.confirmResolvers.delete(id)
      }
    }
    if (this.controller) this.controller.abort()
    this.deps.stopSpeaking?.()
    this.controller = null
    this.running = false
    this.voiceActive = false
    this.deps.broadcast({ kind: 'hud', state: 'idle' })
    this.scheduleHide(400)
  }

  // ------------------------------------------------------------------- turns

  async send(text: string, source: 'voice' | 'text' = 'text'): Promise<void> {
    const clean = text.trim()
    if (!clean) return
    if (this.running) this.cancel()
    await this.turn(clean, source)
  }

  private async turn(text: string, source: 'voice' | 'text'): Promise<void> {
    const settings = this.deps.settings()
    const turnId = randomUUID()
    this.running = true
    this.controller = new AbortController()
    this.clearHudTimer()

    logLine('turn', `start source=${source} chars=${text.length} text=${JSON.stringify(text.slice(0, 200))}`)
    const userItem: ChatItem = { id: turnId, kind: 'user', text, at: Date.now(), source }
    this.items.push(userItem)
    this.deps.broadcast({ kind: 'turn-start', id: turnId, text, source })
    this.deps.broadcast({ kind: 'hud', state: 'thinking', transcript: text })
    this.trim()

    // Capture before the model sees the turn: remembering is a rule, not a
    // decision the small local model can forget to make.
    const captured = this.deps.commitments.capture(text, 'user')
    if (captured) {
      logLine(
        'commitments',
        captured.duplicate
          ? `deduped ${captured.item.id} ${JSON.stringify(captured.item.text.slice(0, 120))}`
          : `captured ${captured.item.id} ${JSON.stringify(captured.item.text.slice(0, 120))}`
      )
    }

    const assistantId = randomUUID()
    const assistantItem: ChatItem = { id: assistantId, kind: 'assistant', text: '', at: Date.now(), streaming: true }
    let assistantStarted = false

    const toolContext: ToolContext = {
      settings,
      commitments: this.deps.commitments,
      confirm: (request) => this.requestConfirmation(request),
      models: this.deps.models,
      notify: (title, body) => this.deps.notify(title, body),
      speak: (spoken) => this.deps.speak(spoken),
      remember: (fact) => {
        void this.deps.memory.addFact(fact)
      }
    }
    toolContext.runTool = (name, args) => executeTool(name, args, toolContext)

    // Steering is per turn: a small model needs the intent restated where it
    // cannot be crowded out by the rest of the prompt.
    const hints: string[] = []
    if (needsSiteCheck(text)) {
      hints.push(
        'They are asking about their own data on a website. Call site_open with the site name first: it finds the URL from history, opens it and returns the page. Read it, then answer from what it says.'
      )
    } else if (needsMusicTaste(text)) {
      hints.push(
        playIntent.test(text)
          ? 'They want music playing. Call play_music once with every track in the request, as "Title — Artist" lines; it starts the first and queues the rest. Do not search, do not ask which one, and do not answer with a list of links.'
          : 'This is about their own listening. Call music_taste before saying anything, then recommend from what it returns. Do not ask what genres they like.'
      )
    }
    if (captured && !captured.duplicate) {
      hints.push(
        `This message was also recorded in the commitment ledger as "${captured.item.text}" (${captured.item.id}). Do not add it again, and do not say you cannot remember it.`
      )
    }
    const hint = hints.length > 0 ? hints.join(' ') : undefined
    const carry = this.openTask ?? undefined
    this.openTask = null
    const task = this.tasks.begin(text, carry)
    if (task.resumed) logLine('task', `resumed ${task.id} for ${JSON.stringify(text.slice(0, 100))}`)

    try {
      // Ollama is a separate process, and a powered-off Mac can leave it
      // stopped. Give the supervisor one chance to bring it back before the
      // model request fails with a connection error.
      if (!(await this.deps.ensureEngine().catch(() => false))) {
        throw new Error(
          'The local engine is offline. Lux tried to start Ollama — open the Ollama app, then try again.'
        )
      }

      const outcome = await runAgent({
        userText: text,
        history: this.historyMessages(),
        settings,
        memory: this.deps.memory,
        models: this.deps.models,
        machine: await this.machineContext(),
        toolContext,
        turnHint: hint,
        openTask: carry,
        taskState: task,
        signal: this.controller.signal,
        emit: (event) => {
          if (event.type === 'token') {
            if (!assistantStarted) {
              assistantStarted = true
              this.items.push(assistantItem)
              this.deps.broadcast({ kind: 'assistant-start', id: assistantId })
            }
            assistantItem.text += event.delta
            this.deps.broadcast({ kind: 'token', id: assistantId, delta: event.delta })
            return
          }
          if (event.type === 'tool-start') {
            this.items.push({ id: `item-${event.run.id}`, kind: 'tool', at: Date.now(), tool: event.run })
            this.deps.broadcast({ kind: 'tool', tool: event.run })
            this.deps.broadcast({ kind: 'hud', state: 'acting', detail: event.run.summary ?? toolLabel(event.run) })
            return
          }
          if (event.type === 'tool-end') {
            logLine(
              'tool',
              `${event.run.name} ${event.run.status} ${event.run.ms ?? 0}ms ${event.run.summary ?? ''}`
            )
            const item = this.items.find(
              (candidate) => candidate.kind === 'tool' && candidate.tool.id === event.run.id
            )
            if (item && item.kind === 'tool') item.tool = event.run
            this.deps.broadcast({ kind: 'tool', tool: event.run })
            return
          }
          if (event.type === 'phase') {
            this.deps.broadcast({
              kind: 'hud',
              state: event.phase,
              detail: event.detail
            })
            return
          }
          if (event.type === 'progress') {
            // A heartbeat: the turn is long, so the HUD shows which step it is on.
            this.deps.broadcast({
              kind: 'hud',
              state: 'acting',
              detail: `${event.label.replace(/^open /, '')} · step ${event.step} · ${Math.round(event.elapsedMs / 1000)}s`
            })
            return
          }
          if (event.type === 'replace') {
            const id = assistantItem.id
            this.items = this.items.map((item) =>
              item.id === id && item.kind === 'assistant' ? { ...item, text: event.text } : item
            )
            assistantItem.text = event.text
            this.deps.broadcast({ kind: 'replace', id, text: event.text })
            return
          }
          if (event.type === 'notice') this.appendSystem(event.text)
        }
      })

      if (outcome.incomplete) {
        this.openTask = outcome.objective
        logLine('agent', `open task kept for next turn: ${outcome.objective.slice(0, 120)}`)
      }

      const finalText = outcome.text.trim()
      logLine(
        'turn',
        `end tools=${outcome.toolRuns.length} hadTools=${outcome.hadTools} reply=${JSON.stringify(finalText.slice(0, 240))}`
      )
      if (!assistantStarted) {
        this.items.push(assistantItem)
        this.deps.broadcast({ kind: 'assistant-start', id: assistantId })
      }
      if (finalText) assistantItem.text = finalText
      assistantItem.streaming = false

      const routed: 'chat' | 'hud' = shouldOpenChat({
        text: finalText,
        hadTools: outcome.hadTools,
        threshold: settings.openChatThreshold,
        userAskedToShow: outcome.forcedChat
      })
        ? 'chat'
        : 'hud'

      this.deps.broadcast({ kind: 'turn-end', id: assistantId, text: assistantItem.text, routed })

      if (routed === 'chat') {
        this.deps.showChat()
        this.deps.broadcast({ kind: 'hud', state: 'done', detail: 'Opened in chat' })
        this.scheduleHide()
      } else {
        this.deps.broadcast({
          kind: 'hud',
          state: 'done',
          detail: assistantItem.text.slice(0, 120) || outcome.toolRuns.at(-1)?.summary
        })
        this.scheduleHide()
      }

      if (source === 'voice' && settings.speechEnabled && assistantItem.text) {
        this.deps.speak(assistantItem.text)
      }

      void this.deps.memory.recordExchange(text, assistantItem.text)
      this.persist()
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      if (aborted) {
        // Close the streaming item so a cancelled turn never leaves a caret behind.
        if (assistantStarted) {
          assistantItem.streaming = false
          this.deps.broadcast({
            kind: 'turn-end',
            id: assistantId,
            text: assistantItem.text,
            routed: 'chat'
          })
        }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        this.appendSystem(message)
        this.deps.broadcast({ kind: 'error', message })
        this.deps.broadcast({ kind: 'hud', state: 'error', detail: message.slice(0, 160) })
        this.scheduleHide()
      }
    } finally {
      this.running = false
      this.controller = null
    }
  }

  private async machineContext(): Promise<MachineContext> {
    const now = Date.now()
    if (this.machineCache && now - this.machineCache.at < 15_000) return this.machineCache.value
    const [apps, battery, volume, front] = await Promise.all([
      runningApps(),
      batteryInfo(),
      outputVolume(),
      frontmostApp()
    ])
    const value = { runningApps: apps, battery, volume: volume ?? 50, frontmostApp: front }
    this.machineCache = { at: now, value }
    return value
  }

  // -------------------------------------------------------------- confirmations

  requestConfirmation(request: { tool: string; args: Record<string, unknown>; reason: string }): Promise<boolean> {
    const id = randomUUID()
    const payload: ConfirmRequest = { id, ...request }
    this.deps.showChat()
    this.deps.broadcast({ kind: 'confirm', request: payload })
    this.deps.broadcast({ kind: 'hud', state: 'acting', detail: 'Waiting for your approval' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.confirmResolvers.delete(id)
        resolve(false)
      }, 60_000)
      this.confirmResolvers.set(id, (approved) => {
        clearTimeout(timer)
        resolve(approved)
      })
    })
  }

  respondToConfirm(id: string, approved: boolean): void {
    const resolver = this.confirmResolvers.get(id)
    if (resolver) {
      this.confirmResolvers.delete(id)
      resolver(approved)
    }
  }

  // ---------------------------------------------------------------- history

  newConversation(): void {
    this.cancel()
    this.startNewConversation(true)
  }

  /** Remove one conversation from disk. The open one is replaced, never left dangling. */
  deleteConversation(id: string): void {
    const index = this.file.list.findIndex((conversation) => conversation.id === id)
    if (index === -1) return
    this.file.list.splice(index, 1)
    logLine('history', `deleted ${id}`)

    if (this.conversationId === id) {
      this.cancel()
      const next = this.file.list[this.file.list.length - 1]
      if (next) {
        this.openConversation(next.id)
        return
      }
      this.startNewConversation(false)
    } else {
      this.persist()
    }
    this.deps.broadcast({ kind: 'history', items: this.items })
  }

  /** Delete every stored conversation and start clean. */
  clearConversations(): void {
    this.cancel()
    this.file.list = []
    this.startNewConversation(false)
    this.deps.broadcast({ kind: 'history', items: [] })
    logLine('history', 'cleared all conversations')
  }

  private startNewConversation(broadcast: boolean): void {
    const id = randomUUID()
    const conversation: StoredConversation = {
      id,
      title: 'New conversation',
      updatedAt: Date.now(),
      items: []
    }
    this.file.list.push(conversation)
    this.conversationId = id
    this.file.active = id
    this.items = conversation.items
    if (this.file.list.length > MAX_CONVERSATIONS) {
      this.file.list = this.file.list.slice(-MAX_CONVERSATIONS)
    }
    this.persist()
    if (broadcast) {
      this.deps.broadcast({ kind: 'history', items: [] })
    }
  }

  openConversation(id: string): void {
    const conversation = this.file.list.find((entry) => entry.id === id)
    if (!conversation) return
    this.cancel()
    this.conversationId = id
    this.file.active = id
    this.items = conversation.items ?? []
    this.persist()
    this.deps.broadcast({ kind: 'history', items: this.items })
  }

  private appendSystem(text: string): void {
    const item: ChatItem = { id: randomUUID(), kind: 'system', text, at: Date.now() }
    this.items.push(item)
    this.deps.broadcast({ kind: 'history', items: this.items })
    this.persist()
  }

  private historyMessages(): OllamaMessage[] {
    const messages: OllamaMessage[] = []
    let chars = 0
    for (const item of this.items.slice(-18)) {
      if (item.kind === 'user') {
        if (chars + item.text.length > 7_000) continue
        messages.push({ role: 'user', content: item.text.slice(0, 1_500) })
        chars += item.text.length
      }
      else if (item.kind === 'assistant' && item.text) {
        // A refusal is not precedent. Feeding "I can't see the site" back to the
        // model teaches it to repeat the claim, so those turns are left out.
        if (isObsoleteRefusal(item.text)) continue
        if (chars + item.text.length > 7_000) continue
        messages.push({ role: 'assistant', content: item.text.slice(0, 2_000) })
        chars += item.text.length
      }
    }
    // Drop the message we are about to send again.
    const last = messages.at(-1)
    if (last?.role === 'user') messages.pop()
    return messages
  }

  private trim(): void {
    if (this.items.length > MAX_ITEMS) this.items = this.items.slice(-MAX_ITEMS)
  }

  private persist(): void {
    const conversation = this.file.list.find((entry) => entry.id === this.conversationId)
    if (conversation) {
      conversation.items = this.items
      conversation.updatedAt = Date.now()
      const firstUser = this.items.find((item) => item.kind === 'user')
      if (firstUser && firstUser.kind === 'user') {
        conversation.title = firstUser.text.slice(0, 46) || 'New conversation'
      }
    }
    this.file.active = this.conversationId
    this.store.write(this.file)
  }

  // ------------------------------------------------------------------- hud

  private scheduleHide(delay = HUD_LINGER_MS): void {
    this.clearHudTimer()
    this.hudTimer = setTimeout(() => {
      this.deps.broadcast({ kind: 'hud', state: 'idle' })
      this.deps.hideHud()
    }, delay)
  }

  private clearHudTimer(): void {
    if (this.hudTimer) clearTimeout(this.hudTimer)
    this.hudTimer = null
  }
}

function toolLabel(run: ToolRun): string {
  return run.name.replace(/_/g, ' ')
}

function emptyStats(): SystemStats {
  return {
    cpuLoad: 0,
    cores: 0,
    memUsedGb: 0,
    memTotalGb: 0,
    memPercent: 0,
    diskPercent: 0,
    batteryPercent: null,
    charging: false,
    onAc: false
  }
}
