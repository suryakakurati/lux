import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const MAX_BYTES = 2_000_000
let logPath = ''

/**
 * A plain append-only log in the app's own support folder.
 *
 * A desktop assistant that answers wrongly is nearly impossible to diagnose
 * from the UI: the model's reply hides which tool ran, what it returned, and
 * whether anything threw. Every turn and tool call lands here, and `--ask` also
 * echoes it to stdout so a packaged build can be exercised from a terminal.
 */
export function initLog(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, 'lux.log')
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) {
      renameSync(logPath, join(dir, 'lux.old.log'))
    }
    logLine('app', `start v${app.getVersion()} packaged=${app.isPackaged} pid=${process.pid}`)
  } catch {
    logPath = ''
  }
}

export function logPathForDisplay(): string {
  return logPath
}

export function logLine(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`
  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`)
    } catch {
      // Logging must never break a turn.
    }
  }
  if (process.env.LUX_ASK || process.env.LUX_DEBUG) process.stdout.write(`${line}\n`)
}
