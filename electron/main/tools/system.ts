import { exec, osascript, truncate } from '../mac/exec'
import { batteryInfo, outputVolume, systemStats } from '../mac/stats'
import type { ToolDef } from './types'

export const systemTools: ToolDef[] = [
  {
    name: 'system_status',
    description:
      'Report live CPU load, memory, disk, battery and volume for this Mac. Use when asked how the machine is doing.',
    risk: 'safe',
    parallelSafe: true,
    params: { type: 'object', properties: {} },
    async run() {
      const [stats, volume] = await Promise.all([systemStats(), outputVolume()])
      const lines = [
        `CPU load: ${stats.cpuLoad} across ${stats.cores} cores`,
        `Memory: ${stats.memUsedGb} GB of ${stats.memTotalGb} GB used (${stats.memPercent}%)`,
        `Disk: ${stats.diskPercent}% used`,
        `Battery: ${stats.batteryPercent ?? 'unknown'}%${stats.charging ? ', charging' : stats.onAc ? ', on power' : ', on battery'}`,
        `Volume: ${volume ?? 'unknown'}%`
      ]
      return {
        content: lines.join('\n'),
        summary: `CPU ${stats.cpuLoad} · RAM ${stats.memPercent}%`,
        openChat: true
      }
    }
  },
  {
    name: 'top_processes',
    description:
      'List the processes using the most memory right now, largest first. Use this for "which apps are using the most memory" — list_apps only lists installed apps.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many processes to return (default 5, max 15).',
          minimum: 1,
          maximum: 15
        }
      }
    },
    async run(args) {
      const limit = Math.min(15, Math.max(1, Number(args.limit ?? 5)))
      const result = await exec('/bin/ps', ['-axo', 'rss=,comm='], { timeout: 5_000 })
      if (result.code !== 0) {
        return { content: `Could not read the process table: ${truncate(result.stderr, 120)}`, summary: 'ps failed' }
      }
      // Chrome and Electron spawn many helpers; one row per app is what the
      // question is actually about.
      const totals = new Map<string, number>()
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line)
        if (!match) continue
        const kb = Number(match[1])
        const name = (match[2].split('/').pop() ?? match[2]).trim()
        if (!name) continue
        totals.set(name, (totals.get(name) ?? 0) + kb)
      }
      const rows = [...totals.entries()]
        .map(([name, kb]) => ({ name, mb: kb / 1_024 }))
        .sort((a, b) => b.mb - a.mb)
        .slice(0, limit)
      if (rows.length === 0) return { content: 'The process table was empty.', summary: 'no processes' }
      return {
        content: rows.map((row) => `${row.name} — ${row.mb.toFixed(0)} MB`).join('\n'),
        summary: `${rows[0].name} ${rows[0].mb.toFixed(0)}MB top`
      }
    }
  },
  {
    name: 'set_volume',
    description: 'Set the Mac output volume. Also handles mute (0) and full volume (100).',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        level: { type: 'integer', description: 'Volume from 0 to 100.', minimum: 0, maximum: 100 }
      },
      required: ['level']
    },
    async run(args) {
      const level = Math.max(0, Math.min(100, Number(args.level)))
      const result = await osascript(`set volume output volume ${level}`)
      if (result.code !== 0) {
        return { content: `Could not set volume: ${truncate(result.stderr, 200)}`, summary: 'volume failed' }
      }
      return { content: `Volume set to ${level}%.`, summary: `volume ${level}%` }
    }
  },
  {
    name: 'get_volume',
    description: 'Read the current output volume and mute state.',
    risk: 'safe',
    parallelSafe: true,
    params: { type: 'object', properties: {} },
    async run() {
      const result = await osascript('get volume settings')
      const level = await outputVolume()
      return {
        content: `Volume is ${level ?? 'unknown'}%. Raw settings: ${result.stdout.trim()}`,
        summary: `volume ${level ?? '?'}%`
      }
    }
  },
  {
    name: 'toggle_appearance',
    description: 'Toggle macOS light/dark appearance, or set it explicitly.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'dark, light, or toggle.', enum: ['dark', 'light', 'toggle'] }
      },
      required: ['mode']
    },
    async run(args) {
      const mode = String(args.mode ?? 'toggle')
      const script =
        mode === 'toggle'
          ? 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'
          : `tell application "System Events" to tell appearance preferences to set dark mode to ${mode === 'dark' ? 'true' : 'false'}`
      const result = await osascript(script)
      if (result.code !== 0) {
        return {
          content: `Could not change appearance. macOS may be waiting for Automation permission for System Events. ${truncate(result.stderr, 200)}`,
          summary: 'appearance blocked'
        }
      }
      return { content: `Switched appearance: ${mode}.`, summary: `appearance ${mode}` }
    }
  },
  {
    name: 'lock_screen',
    description: 'Lock the Mac immediately.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const session = '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession'
      const direct = await exec(session, ['-suspend'], { timeout: 3_000 })
      if (direct.code === 0) return { content: 'Locked the screen.', summary: 'locked' }
      const keys = await osascript(
        'tell application "System Events" to keystroke "q" using {control down, command down}'
      )
      if (keys.code === 0) return { content: 'Locked the screen.', summary: 'locked' }
      return {
        content: 'Could not lock the screen; unlock shortcut automation is blocked by macOS permissions.',
        summary: 'lock blocked'
      }
    }
  },
  {
    name: 'sleep_display',
    description: 'Turn the display off without sleeping the whole machine.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const result = await exec('/usr/bin/pmset', ['displaysleepnow'], { timeout: 3_000 })
      if (result.code !== 0) {
        return { content: `Could not sleep the display: ${truncate(result.stderr, 200)}`, summary: 'failed' }
      }
      return { content: 'Display off.', summary: 'display off' }
    }
  },
  {
    name: 'battery_status',
    description: 'Check battery percentage and charging state.',
    risk: 'safe',
    parallelSafe: true,
    params: { type: 'object', properties: {} },
    async run() {
      const battery = await batteryInfo()
      return {
        content: `Battery ${battery.percent ?? 'unknown'}%${battery.charging ? ', charging' : battery.onAc ? ', plugged in' : ', on battery'}.`,
        summary: `battery ${battery.percent ?? '?'}%`
      }
    }
  }
]
