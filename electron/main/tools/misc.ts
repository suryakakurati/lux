import { clipboard, Notification } from 'electron'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exec, truncate } from '../mac/exec'
import type { ToolDef } from './types'

const timers = new Map<string, NodeJS.Timeout>()

const BLOCKED = [
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(disk|rdisk)/i,
  /:\(\)\s*\{/,
  /\bdiskutil\s+(erase|partition|secureErase)/i,
  /\b(shutdown|reboot|halt)\b/i,
  /curl[^|]*\|\s*(bash|sh|zsh)/i,
  /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*)\s+(\/|~|\$HOME)(\s|$)/,
  /\bkillall\b/i,
  /\blaunchctl\s+(unload|remove|disable)\b/i,
  /\bcsrutil\b/i
]

export const miscTools: ToolDef[] = [
  {
    name: 'clipboard_read',
    description: 'Read the current clipboard text.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const text = await clipboard.readText()
      if (!text.trim()) return { content: 'The clipboard is empty.', summary: 'clipboard empty' }
      return {
        content: truncate(text, 6_000),
        summary: `${text.trim().split(/\s+/).length} words on clipboard`,
        openChat: text.length > 400
      }
    }
  },
  {
    name: 'clipboard_write',
    description: 'Put text on the clipboard.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy.' }
      },
      required: ['text']
    },
    async run(args) {
      const text = String(args.text ?? '')
      await clipboard.writeText(text)
      return { content: 'Copied to clipboard.', summary: 'copied' }
    }
  },
  {
    name: 'set_timer',
    description:
      'Start a countdown timer. Lux notifies you and speaks when it finishes.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Duration in minutes (decimals allowed).', minimum: 0.05, maximum: 600 },
        label: { type: 'string', description: 'What the timer is for, e.g. "tea".' }
      },
      required: ['minutes']
    },
    async run(args, context) {
      const minutes = Number(args.minutes ?? 1)
      const label = String(args.label ?? 'timer').trim() || 'timer'
      const id = `timer-${Date.now()}`
      const timeout = setTimeout(() => {
        timers.delete(id)
        const body = `${label} — ${formatDuration(minutes)} up.`
        context.notify('Lux timer', body)
        context.speak(body)
      }, minutes * 60_000)
      timers.set(id, timeout)
      return {
        content: `Timer set for ${formatDuration(minutes)} (${label}).`,
        summary: `timer ${formatDuration(minutes)}`,
        openChat: false
      }
    }
  },
  {
    name: 'list_timers',
    description: 'List the countdown timers that are still running, with what each one is for.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      if (timers.size === 0) return { content: 'No active timers.', summary: 'no timers' }
      return { content: `${timers.size} timer(s) active.`, summary: `${timers.size} timers` }
    }
  },
  {
    name: 'take_screenshot',
    description: 'Capture the screen to ~/Pictures/Lux and return the file path.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'full screen or selection.', enum: ['full', 'selection'] }
      },
      required: ['mode']
    },
    async run(args) {
      const dir = join(homedir(), 'Pictures', 'Lux')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `Lux ${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
      const flags = args.mode === 'selection' ? ['-i', '-s', file] : ['-x', file]
      const result = await exec('/usr/sbin/screencapture', flags, { timeout: 30_000 })
      if (result.code !== 0) {
        return {
          content: `Screenshot failed: ${truncate(result.stderr, 200)}`,
          summary: 'screenshot failed'
        }
      }
      return { content: `Saved screenshot to ${file}.`, summary: 'screenshot saved', openChat: false }
    }
  },
  {
    name: 'run_shell',
    description:
      'Run a read-oriented shell command and return its output. The person must approve each command first. Never use for long-running or destructive work.',
    risk: 'confirm',
    params: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        reason: { type: 'string', description: 'Why this command is needed.' }
      },
      required: ['command']
    },
    async run(args) {
      const command = String(args.command ?? '').trim()
      const reason = String(args.reason ?? '').trim()
      if (!command) return { content: 'No command given.', summary: 'empty command' }
      const blocked = BLOCKED.find((pattern) => pattern.test(command))
      if (blocked) {
        return {
          content: `Refused: that command matches a destructive pattern (${String(blocked)}).`,
          summary: 'shell blocked'
        }
      }
      const result = await exec('/bin/zsh', ['-lc', command], { timeout: 20_000 })
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      return {
        content: `$ ${command}\n${truncate(output || '(no output)', 4_000)}${reason ? `\n\n(run because: ${reason})` : ''}`,
        summary: `shell · ${command.slice(0, 40)}`,
        openChat: output.length > 200
      }
    }
  }
]

function formatDuration(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  if (mins === 0) return `${secs}s`
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`
}

export function notifyNative(title: string, body: string): void {
  if (!Notification.isSupported()) return
  new Notification({ title, body, silent: false }).show()
}
