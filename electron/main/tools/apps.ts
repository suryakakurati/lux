import { exec, osascript, quoteForAppleScript, truncate } from '../mac/exec'
import type { ToolDef } from './types'

const APP_DIRS = ['/Applications', '/System/Applications', `${process.env.HOME}/Applications`]

export const appTools: ToolDef[] = [
  {
    name: 'open_app',
    description:
      'Open or bring a macOS application to the front. Use the app name as it appears in /Applications.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name, e.g. "Spotify" or "Visual Studio Code".' }
      },
      required: ['name']
    },
    async run(args) {
      const name = String(args.name ?? '').trim()
      const direct = await exec('/usr/bin/open', ['-a', name], { timeout: 8_000 })
      if (direct.code === 0) {
        return { content: `Opened ${name}.`, summary: `open ${name}` }
      }
      const match = await findInstalledApp(name)
      if (match) {
        const retry = await exec('/usr/bin/open', ['-a', match], { timeout: 8_000 })
        if (retry.code === 0) return { content: `Opened ${match}.`, summary: `open ${match}` }
      }
      return {
        content: `Could not find an app named "${name}". Installed apps include: ${(await installedApps()).slice(0, 30).join(', ')}.`,
        summary: `not found: ${name}`
      }
    }
  },
  {
    name: 'quit_app',
    description: 'Quit a running macOS application by name.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Application name.' }
      },
      required: ['name']
    },
    async run(args) {
      const name = String(args.name ?? '').trim()
      const result = await osascript(`tell application "${quoteForAppleScript(name)}" to quit`)
      if (result.code === 0) return { content: `Quit ${name}.`, summary: `quit ${name}` }
      return {
        content: `Could not quit ${name}: ${truncate(result.stderr || 'unknown error', 300)}`,
        summary: `couldn't quit ${name}`
      }
    }
  },
  {
    name: 'list_apps',
    description: 'List the applications installed on this Mac. Useful before opening something.',
    risk: 'safe',
    parallelSafe: true,
    params: { type: 'object', properties: {} },
    async run() {
      const apps = await installedApps()
      return { content: apps.join(', '), summary: `${apps.length} apps`, openChat: false }
    }
  },
  {
    name: 'focus_preset',
    description:
      'Switch the Mac into a focus setup: opens the apps and pages for a preset and sets the volume. Presets: study, coding, focus, reset.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: 'Preset name (study, coding, focus, reset) or any custom preset from settings.'
        }
      },
      required: ['preset']
    },
    async run(args, context) {
      const key = String(args.preset ?? '').toLowerCase().trim()
      const available = context.settings.focusPresets
      const preset = available[key]
      if (!preset) {
        return {
          content: `No preset named "${key}". Available: ${Object.keys(available).join(', ')}.`,
          summary: `unknown preset`
        }
      }
      if (key === 'reset') {
        const volume = 50
        await osascript(`set volume output volume ${volume}`)
        return { content: 'Reset volume to 50%.', summary: 'reset' }
      }
      const opened: string[] = []
      for (const app of preset.apps) {
        const result = await exec('/usr/bin/open', ['-a', app], { timeout: 8_000 })
        if (result.code === 0) opened.push(app)
      }
      for (const url of preset.urls) {
        await exec('/usr/bin/open', [url], { timeout: 8_000 })
      }
      if (typeof preset.volume === 'number') {
        await osascript(`set volume output volume ${Math.max(0, Math.min(100, preset.volume))}`)
      }
      return {
        content: `Set up "${key}": ${opened.join(', ') || 'no apps'}${preset.urls.length ? `, ${preset.urls.length} pages` : ''}${typeof preset.volume === 'number' ? `, volume ${preset.volume}%` : ''}.`,
        summary: `${key} setup`,
        openChat: false
      }
    }
  }
]

let appCache: string[] | null = null

export async function installedApps(): Promise<string[]> {
  if (appCache) return appCache
  const names = new Set<string>()
  for (const dir of APP_DIRS) {
    const result = await exec('/bin/ls', [dir], { timeout: 3_000 })
    for (const entry of result.stdout.split('\n')) {
      if (entry.endsWith('.app')) names.add(entry.replace(/\.app$/, ''))
    }
  }
  appCache = [...names].sort((a, b) => a.localeCompare(b))
  return appCache
}

async function findInstalledApp(query: string): Promise<string | null> {
  const normalised = query.toLowerCase().replace(/[^a-z0-9]/g, '')
  const apps = await installedApps()
  return (
    apps.find((app) => app.toLowerCase().replace(/[^a-z0-9]/g, '') === normalised) ??
    apps.find((app) => app.toLowerCase().replace(/[^a-z0-9]/g, '').includes(normalised)) ??
    null
  )
}
