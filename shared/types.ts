/**
 * Shared contract between the Electron main process and every renderer window.
 * Keeping this in one file means the HUD, chat window and preload bridge cannot
 * drift apart silently.
 */

export type HudState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'planning'
  | 'researching'
  | 'reading'
  | 'verifying'
  | 'acting'
  | 'done'
  | 'brief'
  | 'error'

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

export interface ToolRun {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  summary?: string
  ms?: number
}

export type EngineState = 'checking' | 'ready' | 'starting' | 'waking' | 'offline' | 'missing'

/** `system` follows macOS; the other two pin the app's appearance. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Live state of the local Ollama process and the configured model. */
export interface EngineStatus {
  state: EngineState
  reachable: boolean
  model: string
  /** Human-readable line shown in the rail and the offline banner. */
  detail: string
  at: number
}

export type ChatItem =
  | { id: string; kind: 'user'; text: string; at: number; source: 'voice' | 'text' }
  | { id: string; kind: 'assistant'; text: string; at: number; streaming?: boolean }
  | { id: string; kind: 'tool'; at: number; tool: ToolRun }
  | { id: string; kind: 'system'; text: string; at: number }

export interface SystemStats {
  cpuLoad: number
  cores: number
  memUsedGb: number
  memTotalGb: number
  memPercent: number
  diskPercent: number
  batteryPercent: number | null
  charging: boolean
  onAc: boolean
}

export interface Settings {
  /** Appearance of every Lux window and native control. */
  theme: ThemePreference
  model: string
  embeddingModel: string
  /** Optional second model. It is never loaded unless a task explicitly asks for it. */
  specializedModel: string
  ollamaUrl: string
  /** Tokens of context per request. Larger costs memory on a 16 GB Mac. */
  contextWindow: number
  /** Hard ceiling on generated tokens per model round. */
  maxOutputTokens: number
  /** Ollama keep_alive, e.g. 30m. Empty or 0 unloads when idle. */
  modelKeepAlive: string
  /** Lexical recall needs no embedding model; semantic recall does. */
  memoryMode: 'lexical' | 'semantic'
  speechEnabled: boolean
  voice: string
  speechRate: number
  sttModel: string
  sttEngine: 'auto' | 'whisper-cli' | 'cli' | 'mlx'
  openChatThreshold: number
  keepModelLoaded: boolean
  /** Deliver the deterministic morning brief once a day. */
  proactiveEnabled: boolean
  /** Local time, HH:MM. */
  morningBriefTime: string
  /** Quiet hours may cross midnight; equal times mean off. */
  quietHoursStart: string
  quietHoursEnd: string
  notesDir: string
  vaultPath: string
  /** Optional path to a local SQLite knowledge base. Empty disables those tools. */
  agniDbPath: string
  /** Free Spotify developer app, used only to turn track names into URIs. */
  spotifyClientId: string
  spotifyClientSecret: string
  focusPresets: Record<string, FocusPreset>
  onboarded: boolean
}

export interface FocusPreset {
  apps: string[]
  urls: string[]
  volume?: number
  playlist?: string
}

export interface PermissionsStatus {
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  inputMonitoring: boolean
  automation: 'unknown' | 'granted' | 'denied'
  hotkeyBinary: boolean
}

export interface ConfirmRequest {
  id: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

export type LuxEvent =
  | { kind: 'hud'; state: HudState; transcript?: string; detail?: string }
  | { kind: 'history'; items: ChatItem[] }
  | { kind: 'turn-start'; id: string; text: string; source: 'voice' | 'text' }
  | { kind: 'assistant-start'; id: string }
  | { kind: 'token'; id: string; delta: string }
  | { kind: 'turn-end'; id: string; text: string; routed: 'chat' | 'hud' }
  | { kind: 'tool'; tool: ToolRun }
  | { kind: 'speech'; active: boolean }
  | { kind: 'stats'; stats: SystemStats }
  | { kind: 'settings'; settings: Settings }
  | { kind: 'permissions'; permissions: PermissionsStatus }
  | { kind: 'open-settings' }
  | { kind: 'replace'; id: string; text: string }
  | { kind: 'confirm'; request: ConfirmRequest }
  | { kind: 'error'; message: string }
  | { kind: 'engine'; status: EngineStatus }

export interface Bootstrap {
  items: ChatItem[]
  settings: Settings
  stats: SystemStats
  permissions: PermissionsStatus
  model: string
  ollamaReachable: boolean
  engine: EngineStatus
  conversations: ConversationSummary[]
  activeConversationId: string
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
}

/** The narrow, typed surface exposed on `window.lux` by the preload script. */
export interface LuxBridge {
  onEvent(handler: (event: LuxEvent) => void): () => void
  bootstrap(): Promise<Bootstrap>
  send(text: string): Promise<void>
  cancel(): Promise<void>
  newConversation(): Promise<void>
  openConversation(id: string): Promise<void>
  deleteConversation(id: string): Promise<ConversationSummary[]>
  clearConversations(): Promise<ConversationSummary[]>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  respondToConfirm(id: string, approved: boolean): Promise<void>
  getStats(): Promise<SystemStats>
  listModels(): Promise<string[]>
  engineStatus(): Promise<EngineStatus>
  recoverEngine(): Promise<EngineStatus>
  conversations(): Promise<ConversationSummary[]>
  speakTest(text: string): Promise<void>
  finishSetup(): Promise<void>
  permissions(): Promise<PermissionsStatus>
  openPermissionPane(kind: 'microphone' | 'input' | 'automation' | 'screen'): Promise<void>
  hud: {
    ready(): Promise<boolean>
    defaultDeviceOk(): Promise<boolean>
    start(): Promise<void>
    stop(): Promise<void>
    cancel(): Promise<void>
    audio(wav: ArrayBuffer): void
    error(message: string): void
  }
  win: {
    minimize(): void
    hide(): void
    close(): void
    toggleMaximize(): void
  }
}
