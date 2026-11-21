import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Settings, VoiceOption } from '../../shared/types'
import { chooseVoice, speechText } from '../../shared/speech'
import { exec } from './mac/exec'
import { logLine } from './log'

let current: ChildProcess | null = null
let currentClip: string | null = null
let cachedVoice: string | null = null
let cachedVoiceInfo: VoiceOption | null = null
let cachedVoices: VoiceOption[] | null = null
/** `say` can exit 0 for a voice that is not installed, so presence is checked. */
let installedVoices: Set<string> | null = null

/**
 * Optional neural engine installed by `npm run voice:setup`. Piper runs fully
 * on this Mac, sounds markedly less synthetic than the compact macOS voices,
 * and is only used for the "Automatic" setting so an explicit macOS voice
 * choice is still honoured.
 */
const NEURAL_BIN = join(homedir(), '.cache', 'lux', 'piper-venv', 'bin', 'piper')
const NEURAL_MODEL = join(homedir(), '.cache', 'lux', 'piper', 'en_US-lessac-high.onnx')
let neural: { bin: string; model: string } | null | undefined

export function neuralEngine(): { bin: string; model: string } | null {
  if (neural === undefined) {
    neural =
      existsSync(NEURAL_BIN) && existsSync(NEURAL_MODEL)
        ? { bin: NEURAL_BIN, model: NEURAL_MODEL }
        : null
  }
  return neural
}

/**
 * Speech output. Local, zero-dependency by default, and instantly
 * interruptible — starting a new utterance stops the previous one.
 *
 * Order: the selected macOS voice, or the neural voice for "Automatic" when it
 * is installed. A selected voice that has since been deleted falls back to the
 * automatic choice rather than failing silently.
 */
export function speak(text: string, settings: Settings, onActive?: (active: boolean) => void): void {
  const spoken = speechText(text)
  if (!settings.speechEnabled || !spoken) return
  stopSpeaking()

  const rate = settings.speechRate || 175
  const requested = settings.voice.trim()
  const missing = requested !== '' && installedVoices !== null && !installedVoices.has(requested)
  if (missing) {
    logLine('voice', `"${requested}" is not installed; using the automatic voice`)
  }
  const wanted = missing ? '' : requested
  // A downloaded Premium or Enhanced macOS voice is the best native option; the
  // neural engine is for the compact voices that ship by default.
  const naturalVoice = cachedVoiceInfo !== null && cachedVoiceInfo.quality !== 'standard'
  const engine = neuralEngine()
  if (!wanted && !naturalVoice && engine && startNeural(spoken, engine, rate, onActive)) return

  const automatic = cachedVoice
  startSay(spoken, wanted || automatic, rate, onActive, () => {
    const fallback = automatic && automatic !== wanted ? automatic : null
    logLine(
      'voice',
      `"${wanted}" is not installed; falling back to ${fallback ?? 'the macOS default voice'}`
    )
    startSay(spoken, fallback, rate, onActive, () =>
      startSay(spoken, null, rate, onActive)
    )
  })
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
  discardClip()
}

function startSay(
  spoken: string,
  voice: string | null,
  rate: number,
  onActive: ((active: boolean) => void) | undefined,
  onMissingVoice?: () => void
): void {
  const args = ['-r', String(rate)]
  if (voice) args.push('-v', voice)
  args.push(spoken)

  let child: ChildProcess
  try {
    child = spawn('/usr/bin/say', args, { stdio: 'ignore' })
  } catch {
    current = null
    onActive?.(false)
    return
  }
  current = child
  onActive?.(true)
  child.on('error', () => {
    if (current === child) current = null
    onActive?.(false)
  })
  child.on('exit', (code) => {
    if (current === child) current = null
    onActive?.(false)
    // `say` exits 1 when the named voice is not installed.
    if (code !== 0 && voice) onMissingVoice?.()
  })
}

/** A short sentence should not take longer than the spoken voice's own pace. */
function lengthScale(rate: number): string {
  return Math.min(1.6, Math.max(0.6, 175 / rate)).toFixed(2)
}

function startNeural(
  spoken: string,
  engine: { bin: string; model: string },
  rate: number,
  onActive: ((active: boolean) => void) | undefined
): boolean {
  const clip = join(tmpdir(), `lux-tts-${process.pid}-${Date.now()}.wav`)
  let synth: ChildProcess
  try {
    synth = spawn(
      engine.bin,
      ['-m', engine.model, '-f', clip, '--length-scale', lengthScale(rate)],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    )
  } catch {
    return false
  }

  current = synth
  currentClip = clip
  onActive?.(true)
  // `[[slnc 150]]` is a macOS `say` command; Piper gets the plain sentence.
  synth.stdin?.end(spoken.replace(/\[\[[^\]]*\]\]/g, ' '))
  synth.on('error', () => {
    if (current === synth) current = null
    onActive?.(false)
    discardClip()
    startSay(spoken, cachedVoice, rate, onActive)
  })
  synth.on('exit', (code) => {
    if (current !== synth) return
    current = null
    if (code !== 0 || !existsSync(clip)) {
      onActive?.(false)
      discardClip()
      logLine('voice', 'the neural voice failed; using a macOS voice instead')
      startSay(spoken, cachedVoice, rate, onActive)
      return
    }
    playClip(clip, onActive)
  })
  return true
}

function playClip(clip: string, onActive: ((active: boolean) => void) | undefined): void {
  logLine('voice', 'neural clip ready')
  let player: ChildProcess
  try {
    player = spawn('/usr/bin/afplay', [clip], { stdio: 'ignore' })
  } catch {
    onActive?.(false)
    discardClip()
    return
  }
  current = player
  player.on('error', () => {
    if (current === player) current = null
    onActive?.(false)
    discardClip()
  })
  player.on('exit', () => {
    if (current === player) current = null
    onActive?.(false)
    discardClip()
  })
}

function discardClip(): void {
  if (!currentClip) return
  const clip = currentClip
  currentClip = null
  try {
    unlinkSync(clip)
  } catch {
    /* the file may already be gone */
  }
}

/**
 * Every voice macOS can speak with. Premium and Enhanced downloads appear here
 * as soon as they finish installing; `chooseVoice` puts them first.
 */
export async function listVoices(refresh = false): Promise<VoiceOption[]> {
  if (cachedVoices && !refresh) return cachedVoices
  const result = await exec('/usr/bin/say', ['-v', '?'], { timeout: 5_000 })
  const found: VoiceOption[] = []
  for (const raw of result.stdout.split('\n')) {
    const match = /^(.+?)\s{2,}([a-z]{2})_([A-Z]{2})\s+#/.exec(raw.trim())
    if (!match) continue
    const name = match[1].trim()
    const quality = /\(Premium\)$/i.test(name)
      ? 'premium'
      : /\(Enhanced\)$/i.test(name)
        ? 'enhanced'
        : 'standard'
    found.push({ name, language: `${match[2]}_${match[3]}`, quality })
  }
  // Readable order for the picker: natural voices first, English first.
  installedVoices = new Set(found.map((voice) => voice.name))
  const tier = { premium: 0, enhanced: 1, standard: 2 } as const
  cachedVoices = found.sort(
    (a, b) =>
      tier[a.quality] - tier[b.quality] ||
      Number(!a.language.startsWith('en')) - Number(!b.language.startsWith('en')) ||
      a.name.localeCompare(b.name)
  )
  return cachedVoices
}

/** Pick the most natural installed English voice, so Lux sounds deliberate. */
export async function resolveVoice(refresh = false): Promise<string | null> {
  if (cachedVoice && !refresh) return cachedVoice
  const voices = await listVoices(true)
  cachedVoice = chooseVoice(voices)
  cachedVoiceInfo = voices.find((voice) => voice.name === cachedVoice) ?? null
  return cachedVoice
}
