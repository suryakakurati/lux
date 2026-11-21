import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * A Finder-launched app inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin, so tools
 * installed by Homebrew are invisible even though they are on the login shell's
 * PATH. That is how a working `whisper` install turned into "No local speech
 * engine found". These directories are searched first, for the app and for
 * every child process it starts — Whisper shells out to ffmpeg itself.
 */
const TOOL_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/opt/local/bin',
  join(homedir(), '.local', 'bin')
]

let cachedPath: string | null = null

/** A PATH that includes the machine's package-manager binaries. */
export function toolPath(): string {
  if (cachedPath) return cachedPath
  const seen = new Set<string>()
  const dirs = [...TOOL_DIRS, ...(process.env.PATH ?? '').split(':')]
    .map((dir) => dir.trim())
    .filter((dir) => dir && !seen.has(dir) && seen.add(dir))
  cachedPath = dirs.join(':')
  return cachedPath
}

/** Absolute path to an installed executable, or null. Do not rely on `which`. */
export function findBinary(name: string): string | null {
  for (const dir of toolPath().split(':')) {
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* not in this directory */
    }
  }
  return null
}

/**
 * Run a macOS binary with a hard timeout. Every automation path in Lux goes
 * through here so no single tool can hang the assistant.
 */
export function exec(
  file: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecResult> {
  const timeout = options.timeout ?? 10_000
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout,
        cwd: options.cwd,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...options.env, PATH: options.env?.PATH ?? toolPath(), LUX: '1' }
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? (err && !stderr ? err.message : ''),
          timedOut: Boolean(err?.killed)
        })
      }
    )
    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input)
    }
  })
}

/** AppleScript escape for a string literal embedded in a script. */
export function quoteForAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function osascript(script: string, timeout = 8_000): Promise<ExecResult> {
  return exec('/usr/bin/osascript', ['-e', script], { timeout })
}

export function truncate(text: string, max = 4_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[${text.length - max} more characters]`
}
