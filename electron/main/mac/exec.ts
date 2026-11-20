import { execFile } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a macOS binary with a hard timeout. Every automation path in Lux goes
 * through here so no single tool can hang the assistant.
 */
export function exec(
  file: string,
  args: string[] = [],
  options: { timeout?: number; cwd?: string; input?: string } = {}
): Promise<ExecResult> {
  const timeout = options.timeout ?? 10_000
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout, cwd: options.cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LUX: '1' } },
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
