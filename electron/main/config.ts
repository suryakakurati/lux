import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseClock } from '../../shared/commitments'
import type { FocusPreset, Settings } from '../../shared/types'
import { detectObsidianVault } from './mac/obsidian'
import { Store } from './store'

const DEFAULT_PRESETS: Record<string, FocusPreset> = {
  study: {
    apps: ['Safari'],
    urls: ['https://chatgpt.com', 'https://www.notion.so'],
    volume: 35
  },
  coding: {
    apps: ['Visual Studio Code'],
    urls: ['https://github.com', 'https://stackoverflow.com'],
    volume: 40
  },
  focus: {
    apps: [],
    urls: [],
    volume: 20
  }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  model: 'qwen3.5:latest',
  embeddingModel: 'nomic-embed-text:latest',
  specializedModel: '',
  ollamaUrl: 'http://127.0.0.1:11434',
  // 16K is the smallest window that holds the system prompt, a few tool
  // results and a real conversation. 8K left no room for history on research.
  contextWindow: 16384,
  maxOutputTokens: 1536,
  modelKeepAlive: '30m',
  memoryMode: 'lexical',
  speechEnabled: true,
  voice: '',
  speechRate: 185,
  sttModel: 'base.en',
  sttEngine: 'auto',
  openChatThreshold: 220,
  keepModelLoaded: true,
  proactiveEnabled: true,
  morningBriefTime: '08:30',
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  notesDir: '',
  vaultPath: '',
  agniDbPath: '',
  spotifyClientId: '',
  spotifyClientSecret: '',
  focusPresets: DEFAULT_PRESETS,
  onboarded: false
}

let settingsStore: Store<Settings> | null = null

export function dataDir(): string {
  // A temporary data directory makes end-to-end tests on this Mac possible
  // without touching the real ledger, conversations or settings.
  const override = process.env.LUX_DATA_DIR?.trim()
  const dir = override ? resolve(override) : join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function defaultNotesDir(): string {
  return join(homedir(), 'Documents', 'Lux', 'Notes')
}

export function getSettings(): Settings {
  if (!settingsStore) {
    settingsStore = new Store<Settings>(join(dataDir(), 'settings.json'), DEFAULT_SETTINGS)
  }
  const stored = settingsStore.read()
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    focusPresets: { ...DEFAULT_PRESETS, ...(stored.focusPresets ?? {}) }
  }
  // 8,192 was the old fixed default, and a stored 8,192 is far more likely to
  // be that default than a considered choice. It leaves no room for history on
  // a tool-heavy turn, so a legacy value moves up to the current default once.
  if (stored.contextWindow === 8_192) merged.contextWindow = DEFAULT_SETTINGS.contextWindow
  if (!merged.notesDir) merged.notesDir = defaultNotesDir()
  // Use the vault Obsidian already has open unless the person set one explicitly.
  if (!merged.vaultPath) merged.vaultPath = detectObsidianVault()
  return merged
}

export function saveSettings(patch: Partial<Settings>): Settings {
  if (!settingsStore) settingsStore = new Store<Settings>(join(dataDir(), 'settings.json'), DEFAULT_SETTINGS)
  const next: Settings = { ...getSettings(), ...patch }
  if (next.openChatThreshold < 40) next.openChatThreshold = 40
  next.contextWindow = Math.min(65_536, Math.max(2_048, Number(next.contextWindow) || 16_384))
  next.maxOutputTokens = Math.min(8_192, Math.max(256, Number(next.maxOutputTokens) || 1_536))
  if (!next.modelKeepAlive.trim()) next.modelKeepAlive = '30m'
  if (next.theme !== 'light' && next.theme !== 'dark') next.theme = 'system'
  if (next.memoryMode !== 'lexical' && next.memoryMode !== 'semantic') next.memoryMode = 'lexical'
  // A malformed time would silently disable delivery or quiet hours.
  if (parseClock(next.morningBriefTime) === null) next.morningBriefTime = DEFAULT_SETTINGS.morningBriefTime
  if (parseClock(next.quietHoursStart) === null) next.quietHoursStart = DEFAULT_SETTINGS.quietHoursStart
  if (parseClock(next.quietHoursEnd) === null) next.quietHoursEnd = DEFAULT_SETTINGS.quietHoursEnd
  settingsStore.write(next)
  return next
}
