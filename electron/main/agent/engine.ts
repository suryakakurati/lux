/**
 * Local engine supervisor.
 *
 * Ollama is a separate process, and macOS does not restart it for us. After the
 * Mac has been asleep — or off — for a long time the app can still be open while
 * the engine is gone, which used to surface as a raw "Can't reach Ollama" error
 * on the next question. This module watches the engine, launches Ollama when it
 * is missing, waits for the API, and loads the configured model into memory
 * before a turn needs it.
 *
 * It never touches a non-loopback URL: a remote Ollama is someone else's
 * process, so Lux only reports the failure.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { EngineState, EngineStatus, Settings } from '../../../shared/types'
import { logLine } from '../log'
import { listModels, ping } from './ollama'

const POLL_MS = 20_000
const LAUNCH_COOLDOWN_MS = 60_000
const READY_TRUST_MS = 10_000
const START_TIMEOUT_MS = 30_000

const OLLAMA_BINARIES = [
  '/Applications/Ollama.app/Contents/Resources/ollama',
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  join(homedir(), '.local/bin/ollama')
]

type Reason = 'startup' | 'poll' | 'resume' | 'turn' | 'manual'

export class EngineSupervisor {
  private status: EngineStatus
  private work: Promise<EngineStatus> | null = null
  private timer: NodeJS.Timeout | null = null
  private lastCheck = 0
  private lastLaunch = 0

  constructor(
    private readonly settings: () => Settings,
    private readonly publish: (status: EngineStatus) => void
  ) {
    this.status = {
      state: 'checking',
      reachable: false,
      model: this.settings().model,
      detail: 'Checking the local engine…',
      at: Date.now()
    }
  }

  current(): EngineStatus {
    return this.status
  }

  start(): void {
    void this.ensure('startup')
    this.timer ??= setInterval(() => void this.ensure('poll'), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Single-flight check. A ready engine is trusted for a few seconds on the
   * turn path so an ordinary question never pays for a status round trip.
   */
  async ensure(reason: Reason): Promise<EngineStatus> {
    if (this.work) return this.work
    const now = Date.now()
    if (reason === 'turn' && this.status.state === 'ready' && now - this.lastCheck < READY_TRUST_MS) {
      return this.status
    }
    this.work = this.run(reason).finally(() => {
      this.work = null
    })
    return this.work
  }

  private async run(reason: Reason): Promise<EngineStatus> {
    const settings = this.settings()
    const url = settings.ollamaUrl
    this.lastCheck = Date.now()
    logLine('engine', `check (${reason})`)

    if (await ping(url)) return this.whenReachable(settings, reason)

    if (!isLocal(url)) {
      return this.set('offline', false, `Can't reach the engine at ${url}. Check the URL in Settings.`)
    }

    this.set('starting', false, 'The local engine was asleep — starting Ollama.')
    this.launch()

    // Ollama.app can take several seconds to bring its server up. If it has not
    // answered by then, start the bundled CLI as a second, independent attempt.
    if (!(await waitFor(url, 12_000))) {
      this.launchServe()
      if (!(await waitFor(url, START_TIMEOUT_MS - 12_000))) {
        return this.set(
          'offline',
          false,
          'Ollama did not start. Open the Ollama app, then retry — or run "ollama serve".'
        )
      }
    }

    logLine('engine', 'ollama is answering again')
    return this.whenReachable(settings, reason)
  }

  /** Once the API is up, make sure the model Lux needs is actually usable. */
  private async whenReachable(settings: Settings, reason: Reason): Promise<EngineStatus> {
    const models = await listModels(settings.ollamaUrl)
    if (models.length === 0) {
      return this.set(
        'missing',
        true,
        `Ollama is running, but no models are installed. Run "ollama pull ${settings.model}" in Terminal.`
      )
    }

    if (!models.some((name) => sameModel(name, settings.model))) {
      const fallback = models.find((name) => !/embed/i.test(name))
      return this.set(
        'missing',
        true,
        `Model ${settings.model} is not installed.${fallback ? ` ${fallback} is available — choose it in Settings.` : ''}`
      )
    }

    // A freshly launched engine has no model resident. Loading it now means the
    // first question is answered instead of spending 30 seconds on a cold load.
    // Preloading is a local courtesy. Never hold memory on a server the person
    // pointed Lux at remotely.
    if (settings.keepModelLoaded && reason !== 'turn' && isLocal(settings.ollamaUrl)) {
      const resident = await residentModels(settings.ollamaUrl)
      if (!resident.some((name) => sameModel(name, settings.model))) {
        this.set('waking', true, `Loading ${settings.model} into memory…`)
        const warm = await warmModel(settings)
        if (!warm.ok) {
          if (warm.missing) {
            return this.set('missing', true, `Model ${settings.model} is not installed. Run "ollama pull ${settings.model}".`)
          }
          return this.set('offline', false, warm.detail ?? 'The engine answered, but the model could not be loaded.')
        }
        logLine('engine', `model ${settings.model} loaded`)
      }
    }

    return this.set('ready', true, `${settings.model} · ready on this Mac`)
  }

  private set(state: EngineState, reachable: boolean, detail: string): EngineStatus {
    if (this.status.state === state && this.status.reachable === reachable && this.status.detail === detail) {
      return this.status
    }
    this.status = { state, reachable, model: this.settings().model, detail, at: Date.now() }
    if (state === 'offline' || state === 'missing') logLine('engine', `${state}: ${detail}`)
    this.publish(this.status)
    return this.status
  }

  /** `open -a Ollama` gives the menu-bar app, which also starts its server. */
  private launch(): void {
    if (process.platform !== 'darwin') return
    if (Date.now() - this.lastLaunch < LAUNCH_COOLDOWN_MS) return
    this.lastLaunch = Date.now()
    execFile('/usr/bin/open', ['-a', 'Ollama'], { timeout: 6_000 }, (error) => {
      if (error) {
        logLine('engine', `open Ollama failed: ${error.message}`)
        this.launchServe()
        return
      }
      logLine('engine', 'opened Ollama.app')
    })
  }

  /** Fallback for Homebrew installs where the .app is missing or broken. */
  private launchServe(): void {
    if (process.platform !== 'darwin') return
    const binary = OLLAMA_BINARIES.find((candidate) => existsSync(candidate))
    if (!binary) {
      logLine('engine', 'no Ollama binary found to start')
      return
    }
    const path = [dirname(binary), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? ''].join(':')
    const child = spawn(binary, ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: path }
    })
    child.on('error', (error) => logLine('engine', `serve failed: ${error.message}`))
    child.unref()
    logLine('engine', `started ${binary} serve`)
  }
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

function sameModel(a: string, b: string): boolean {
  const normalise = (name: string): string => name.replace(/:latest$/, '')
  return normalise(a) === normalise(b)
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ping(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 750))
  }
  return false
}

async function residentModels(url: string): Promise<string[]> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(2_500) })
    if (!response.ok) return []
    const data = (await response.json()) as { models?: { name?: string }[] }
    return (data.models ?? []).map((model) => model.name ?? '').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * An empty `/api/generate` is Ollama's documented way to load a model without
 * producing a reply; `keep_alive` matches the chat requests Lux makes.
 *
 * `num_ctx` must match the chat requests too: warming at Ollama's 4K default
 * made the first real turn reload the model at 24K, which cost seconds and left
 * the resident model reporting a context the app never used.
 */
async function warmModel(settings: Settings): Promise<{ ok: boolean; missing?: boolean; detail?: string }> {
  try {
    const response = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        prompt: '',
        stream: false,
        keep_alive: settings.modelKeepAlive || '30m',
        options: { num_ctx: settings.contextWindow || 24_576 }
      }),
      signal: AbortSignal.timeout(180_000)
    })
    if (response.ok) return { ok: true }
    const detail = await response.text().catch(() => '')
    logLine('engine', `warm failed ${response.status}: ${detail.slice(0, 200)}`)
    return { ok: false, missing: response.status === 404, detail: detail.slice(0, 200) || `Ollama returned ${response.status}.` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
