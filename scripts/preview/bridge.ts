/**
 * A stand-in for the Electron preload bridge, for reviewing the renderer in a
 * plain browser (`npm run preview:renderer`).
 *
 * The real app is macOS + Electron. This file lets the actual React windows,
 * styles and interactions run anywhere, with a handful of scripted turns in
 * place of a model. It is a development tool: it is not bundled into the app,
 * it never talks to Ollama, and none of its data is persisted.
 */

import type {
  Bootstrap,
  ChatItem,
  ConversationSummary,
  EngineStatus,
  LuxBridge,
  LuxEvent,
  PermissionsStatus,
  Settings,
  SystemStats,
  ToolRun,
  VoiceOption
} from '../../shared/types'

const START = Date.now()

const SETTINGS: Settings = {
  theme: 'system',
  model: 'qwen3.5:latest',
  embeddingModel: 'nomic-embed-text:latest',
  specializedModel: '',
  ollamaUrl: 'http://127.0.0.1:11434',
  contextWindow: 24576,
  maxOutputTokens: 4096,
  modelKeepAlive: '30m',
  memoryMode: 'lexical',
  speechEnabled: true,
  voice: '',
  speechRate: 175,
  sttModel: 'base.en',
  sttEngine: 'auto',
  openChatThreshold: 220,
  keepModelLoaded: true,
  proactiveEnabled: true,
  morningBriefTime: '08:30',
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  notesDir: '/Users/you/Documents/Lux/Notes',
  vaultPath: '',
  agniDbPath: '',
  spotifyClientId: '',
  spotifyClientSecret: '',
  focusPresets: {},
  onboarded: true
}

const STATS: SystemStats = {
  cpuLoad: 3.4,
  cores: 10,
  memUsedGb: 9.1,
  memTotalGb: 16,
  memPercent: 57,
  diskPercent: 62,
  batteryPercent: 78,
  charging: false,
  onAc: false
}

const PERMISSIONS: PermissionsStatus = {
  microphone: 'granted',
  inputMonitoring: true,
  automation: 'unknown',
  hotkeyBinary: true
}

const ENGINE: EngineStatus = {
  state: 'ready',
  reachable: true,
  model: 'qwen3.5:latest',
  detail: 'qwen3.5:latest · ready on this Mac',
  at: START
}

const VOICES: VoiceOption[] = [
  { name: 'Ava (Premium)', language: 'en_US', quality: 'premium' },
  { name: 'Samantha', language: 'en_US', quality: 'standard' },
  { name: 'Daniel', language: 'en_GB', quality: 'standard' }
]

interface Conversation {
  id: string
  title: string
  updatedAt: number
  items: ChatItem[]
}

let settings: Settings = { ...SETTINGS }
let activeId = ''
let counter = 0
const listeners = new Set<(event: LuxEvent) => void>()
const pendingConfirms = new Map<string, (approved: boolean) => void>()

function uid(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}`
}

function seed(): Conversation[] {
  const tool: ToolRun = {
    id: 'tool-seed-1',
    name: 'system_status',
    args: {},
    status: 'ok',
    summary: 'battery 78%, 9.1 GB of 16 GB used',
    ms: 41
  }
  return [
    {
      id: 'c-welcome',
      title: 'How is this Mac doing?',
      updatedAt: START - 6 * 60_000,
      items: [
        { id: 'm1', kind: 'user', text: 'How is this Mac doing?', at: START - 6 * 60_000, source: 'text' },
        { id: 'm2', kind: 'tool', at: START - 6 * 60_000 + 900, tool },
        {
          id: 'm3',
          kind: 'assistant',
          at: START - 6 * 60_000 + 2_000,
          text:
            'Battery is at 78% and not charging. Memory is 9.1 of 16 GB used (57%), CPU load is low, and the disk is 62% full.\n\nNothing needs attention.'
        }
      ]
    },
    {
      id: 'c-brief',
      title: 'Morning brief',
      updatedAt: START - 26 * 60_000,
      items: [
        {
          id: 'm4',
          kind: 'assistant',
          at: START - 26 * 60_000,
          text: 'Good morning.\n\n• Submit the security form — due today\n• Reply to Priya about the audit — due Thursday\n\nOne item is due today.'
        }
      ]
    }
  ]
}

let conversations = seed()
activeId = conversations[0].id

function emit(event: LuxEvent): void {
  for (const listener of [...listeners]) listener(event)
}

function summarise(): ConversationSummary[] {
  return conversations
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function current(): Conversation {
  const found = conversations.find((conversation) => conversation.id === activeId)
  if (found) return found
  const created: Conversation = { id: uid('c'), title: 'New conversation', updatedAt: Date.now(), items: [] }
  conversations = [created, ...conversations]
  activeId = created.id
  return created
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

/** A scripted turn: tool rows for known intents, then a streamed reply. */
async function scriptedTurn(text: string): Promise<void> {
  const conversation = current()
  const turnId = uid('turn')
  const replyId = uid('reply')
  conversation.items.push({ id: turnId, kind: 'user', text, at: Date.now(), source: 'text' })
  conversation.updatedAt = Date.now()
  emit({ kind: 'turn-start', id: turnId, text, source: 'text' })
  emit({ kind: 'hud', state: 'planning', transcript: text })

  const tools: { name: string; args: Record<string, unknown>; summary: string; data: string }[] = []
  if (/battery|mac|system|memory|cpu/i.test(text)) {
    tools.push({
      name: 'system_status',
      args: {},
      summary: 'battery 78%, 9.1 GB of 16 GB used',
      data: 'battery 78% (on battery), memory 9.1/16 GB, disk 62%'
    })
  }
  if (/clipboard/i.test(text)) {
    tools.push({
      name: 'clipboard_read',
      args: {},
      summary: '14 words on clipboard',
      data: 'the release checklist is in the shared drive'
    })
  }
  if (/music|song|play/i.test(text)) {
    tools.push({ name: 'now_playing', args: {}, summary: 'nothing is playing', data: 'Spotify is not running.' })
  }
  if (/shell|sudo|rm /i.test(text)) {
    tools.push({
      name: 'run_shell',
      args: { command: 'ls -la ~/Documents', reason: 'List the Documents folder.' },
      summary: 'shell · ls -la ~/Documents',
      data: 'Documents\nNotes\nProjects'
    })
  }

  for (const tool of tools) {
    const run: ToolRun = { id: uid('tool'), name: tool.name, args: tool.args, status: 'running' }
    conversation.items.push({ id: uid('item'), kind: 'tool', at: Date.now(), tool: run })
    emit({ kind: 'tool', tool: run })
    emit({ kind: 'hud', state: 'acting', detail: tool.name.replace(/_/g, ' ') })
    await wait(650)
    if (tool.name === 'run_shell') {
      const request = { id: uid('confirm'), tool: tool.name, args: tool.args, reason: 'List the Documents folder.' }
      emit({ kind: 'confirm', request })
      const approved = await new Promise<boolean>((resolve) => pendingConfirms.set(request.id, resolve))
      if (!approved) {
        const denied: ToolRun = { ...run, status: 'denied', summary: 'declined', ms: 0 }
        replaceTool(conversation, denied)
        emit({ kind: 'tool', tool: denied })
        const message = 'I did not run that command. Tell me what you would prefer instead.'
        emit({ kind: 'assistant-start', id: replyId })
        await stream(conversation, replyId, message)
        emit({ kind: 'turn-end', id: replyId, text: message, routed: 'chat' })
        return
      }
    }
    const finished: ToolRun = { ...run, status: 'ok', summary: tool.summary, ms: 40 + Math.floor(Math.random() * 260) }
    replaceTool(conversation, finished)
    emit({ kind: 'tool', tool: finished })
  }

  const reply = composeReply(text, tools.map((tool) => tool.name))
  emit({ kind: 'assistant-start', id: replyId })
  emit({ kind: 'hud', state: 'verifying', detail: 'Checking the result.' })
  await stream(conversation, replyId, reply)
  emit({ kind: 'turn-end', id: replyId, text: reply, routed: reply.length > settings.openChatThreshold ? 'chat' : 'hud' })
  conversation.title = text.slice(0, 46)
  conversation.updatedAt = Date.now()
}

function replaceTool(conversation: Conversation, tool: ToolRun): void {
  const index = conversation.items.findIndex((item) => item.kind === 'tool' && item.tool.id === tool.id)
  if (index >= 0) conversation.items[index] = { id: conversation.items[index].id, kind: 'tool', at: Date.now(), tool }
}

async function stream(conversation: Conversation, id: string, text: string): Promise<void> {
  const item: ChatItem = { id, kind: 'assistant', text: '', at: Date.now(), streaming: true }
  conversation.items.push(item)
  for (const word of words(text)) {
    item.text += word
    emit({ kind: 'token', id, delta: word })
    await wait(28)
  }
  item.streaming = false
}

function composeReply(text: string, tools: string[]): string {
  if (tools.includes('run_shell')) {
    return 'Here is the Documents folder: `Notes` and `Projects`, plus the folder itself. Nothing else in it.'
  }
  if (tools.includes('now_playing')) {
    return 'Spotify is not running, so nothing is playing. Open it and ask again and I will read the current track.'
  }
  if (tools.includes('clipboard_read')) {
    return 'Your clipboard says: “the release checklist is in the shared drive”. It is 14 words.'
  }
  if (tools.includes('system_status')) {
    return 'Battery is at 78% and discharging. Memory is 9.1 of 16 GB used (57%), CPU load is 3.4 across 10 cores, and the disk is 62% full. Nothing is under pressure.'
  }
  if (/what can you do|capabilities/i.test(text)) {
    return [
      'I run entirely on this Mac. I can:',
      '',
      '- read and change the machine: battery, memory, volume, appearance, lock, sleep',
      '- open and quit apps, and run a focus preset',
      '- search the web, read pages and research several sources with citations',
      '- read Firefox, Chrome and Safari history, and the pages you already use',
      '- play and queue music, and read what you have been listening to',
      '- find files, preview them and write markdown notes',
      '- keep a ledger of commitments and deliver a morning brief',
      '- run a shell command or take a screenshot, both with your approval'
    ].join('\n')
  }
  return `I heard “${text.trim()}”. This preview is scripted, so it cannot run real tools — the packaged app answers from the local model and the macOS tools.`
}

const bridge: LuxBridge = {
  onEvent(handler) {
    listeners.add(handler)
    return () => listeners.delete(handler)
  },

  async bootstrap(): Promise<Bootstrap> {
    return {
      version: '0.2.1-preview',
      items: current().items,
      settings,
      stats: STATS,
      permissions: PERMISSIONS,
      model: settings.model,
      ollamaReachable: true,
      engine: ENGINE,
      conversations: summarise(),
      activeConversationId: activeId
    }
  },
  async appVersion() {
    return '0.2.1-preview'
  },
  async send(text) {
    await scriptedTurn(text)
  },
  async cancel() {
    emit({ kind: 'error', message: 'Stopped.' })
  },
  async newConversation() {
    const created: Conversation = { id: uid('c'), title: 'New conversation', updatedAt: Date.now(), items: [] }
    conversations = [created, ...conversations]
    activeId = created.id
    emit({ kind: 'history', items: [] })
  },
  async openConversation(id) {
    activeId = id
    emit({ kind: 'history', items: current().items })
  },
  async deleteConversation(id) {
    conversations = conversations.filter((conversation) => conversation.id !== id)
    if (activeId === id) activeId = conversations[0]?.id ?? ''
    emit({ kind: 'history', items: current().items })
    return summarise()
  },
  async clearConversations() {
    conversations = []
    activeId = ''
    return summarise()
  },
  async getSettings() {
    return settings
  },
  async saveSettings(patch) {
    settings = { ...settings, ...patch }
    emit({ kind: 'settings', settings })
    return settings
  },
  async respondToConfirm(id, approved) {
    const resolve = pendingConfirms.get(id)
    pendingConfirms.delete(id)
    resolve?.(approved)
  },
  async getStats() {
    return STATS
  },
  async listModels() {
    return ['qwen3.5:latest', 'llama3.3:70b', 'nomic-embed-text:latest']
  },
  async engineStatus() {
    return ENGINE
  },
  async recoverEngine() {
    emit({ kind: 'engine', status: { ...ENGINE, state: 'starting', detail: 'Starting Ollama…' } })
    await wait(1_200)
    emit({ kind: 'engine', status: ENGINE })
    return ENGINE
  },
  async conversations() {
    return summarise()
  },
  async speakTest() {
    /* no audio in a browser preview */
  },
  async listVoices() {
    return VOICES
  },
  async openVoiceSettings() {
    /* system settings are not reachable from the preview */
  },
  async finishSetup() {
    settings = { ...settings, onboarded: true }
  },
  async permissions() {
    return PERMISSIONS
  },
  async openPermissionPane() {
    /* no macOS panes in a browser */
  },
  hud: {
    async ready() {
      return false
    },
    async defaultDeviceOk() {
      return false
    },
    async start() {
      emit({ kind: 'hud', state: 'listening' })
    },
    async stop() {
      emit({ kind: 'hud', state: 'transcribing' })
    },
    async cancel() {
      emit({ kind: 'hud', state: 'idle' })
    },
    audio() {
      /* recording is not exercised in the preview */
    },
    error(message) {
      emit({ kind: 'hud', state: 'error', detail: message })
    }
  },
  win: {
    minimize() {},
    hide() {},
    close() {},
    toggleMaximize() {}
  }
}

window.lux = bridge
