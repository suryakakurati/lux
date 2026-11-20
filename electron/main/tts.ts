import { spawn, type ChildProcess } from 'node:child_process'
import type { Settings } from '../../shared/types'
import { exec } from './mac/exec'

let current: ChildProcess | null = null
let cachedVoice: string | null = null

/**
 * Speech output through macOS `say`. Local, zero-dependency, and instantly
 * interruptible — starting a new utterance stops the previous one.
 */
export function speak(text: string, settings: Settings, onActive?: (active: boolean) => void): void {
  const spoken = toSpeech(text)
  if (!settings.speechEnabled || !spoken) return
  stopSpeaking()

  const args = ['-r', String(settings.speechRate || 185)]
  const voice = settings.voice || cachedVoice
  if (voice) args.push('-v', voice)
  args.push(spoken)

  try {
    current = spawn('/usr/bin/say', args, { stdio: 'ignore' })
    onActive?.(true)
    current.on('exit', () => {
      current = null
      onActive?.(false)
    })
    current.on('error', () => {
      current = null
      onActive?.(false)
    })
  } catch {
    current = null
    onActive?.(false)
  }
}

export function stopSpeaking(): void {
  if (current) {
    try {
      current.kill()
    } catch {
      /* already gone */
    }
    current = null
  }
}

/** Strip markdown so the voice never reads asterisks or code fences aloud. */
export function toSpeech(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= 480) return plain
  return `${plain.slice(0, 480).replace(/[,;:\s]+\S*$/, '')}…`
}

const PREFERRED_VOICES = [
  'Ava (Premium)',
  'Zoe (Premium)',
  'Samantha',
  'Ava',
  'Allison',
  'Alex',
  'Daniel'
]

/** Pick the best installed English voice once, so Lux sounds deliberate. */
export async function resolveVoice(): Promise<string | null> {
  if (cachedVoice) return cachedVoice
  const result = await exec('/usr/bin/say', ['-v', '?'], { timeout: 4_000 })
  const installed = new Set<string>()
  for (const line of result.stdout.split('\n')) {
    const match = /^(.+?)\s{2,}[a-z]{2}_[A-Z]{2}/.exec(line.trim())
    if (match?.[1]) installed.add(match[1].trim())
  }
  for (const candidate of PREFERRED_VOICES) {
    if (installed.has(candidate)) {
      cachedVoice = candidate
      return candidate
    }
  }
  cachedVoice = null
  return null
}
