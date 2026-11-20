import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createInterface } from 'node:readline'

export interface HotkeyHandlers {
  onDown: () => void
  onUp: () => void
  onChat: () => void
  onPermission: (granted: boolean) => void
  onStateChange: (state: HotkeyState) => void
}

export interface HotkeyState {
  binaryFound: boolean
  running: boolean
  permissionGranted: boolean
}

/**
 * Owns the native listener process that reports right-Option edges.
 * It restarts itself if the helper dies and polls permission while denied.
 */
export class HotkeyBridge {
  private child: ChildProcess | null = null
  private stopping = false
  private retry: NodeJS.Timeout | null = null
  private state: HotkeyState = { binaryFound: false, running: false, permissionGranted: false }

  constructor(private readonly handlers: HotkeyHandlers) {}

  getState(): HotkeyState {
    return { ...this.state }
  }

  start(): void {
    const binary = this.resolveBinary()
    this.state = { ...this.state, binaryFound: Boolean(binary) }
    this.handlers.onStateChange(this.getState())
    if (!binary) {
      console.warn('[hotkey] native helper not built; run `npm run hotkey`')
      return
    }

    this.stopping = false
    const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.state = { ...this.state, running: true }
    this.handlers.onStateChange(this.getState())

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => this.handleLine(line))
    }
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) console.warn('[hotkey]', text)
    })

    child.on('exit', (code) => {
      this.child = null
      this.state = { ...this.state, running: false }
      this.handlers.onStateChange(this.getState())
      if (!this.stopping) {
        console.warn(`[hotkey] helper exited (${code}); retrying in 2s`)
        this.retry = setTimeout(() => this.start(), 2_000)
      }
    })
  }

  stop(): void {
    this.stopping = true
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.child?.kill('SIGTERM')
    this.child = null
    this.state = { ...this.state, running: false }
  }

  private handleLine(line: string): void {
    let payload: { event?: string; granted?: boolean }
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    switch (payload.event) {
      case 'down':
        this.handlers.onDown()
        break
      case 'up':
        this.handlers.onUp()
        break
      case 'chat':
        this.handlers.onChat()
        break
      case 'ready':
        this.state = { ...this.state, permissionGranted: true }
        this.handlers.onPermission(true)
        this.handlers.onStateChange(this.getState())
        break
      case 'permission':
      case 'denied':
        this.state = { ...this.state, permissionGranted: false }
        this.handlers.onPermission(false)
        this.handlers.onStateChange(this.getState())
        break
      default:
        break
    }
  }

  private resolveBinary(): string | null {
    const candidates = [
      app.isPackaged ? join(process.resourcesPath, 'bin', 'lux-hotkey') : '',
      join(app.getAppPath(), 'resources', 'bin', 'lux-hotkey'),
      join(app.getAppPath(), 'native', 'hotkey', 'build', 'lux-hotkey'),
      join(process.cwd(), 'resources', 'bin', 'lux-hotkey')
    ].filter(Boolean)
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}
