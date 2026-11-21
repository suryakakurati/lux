import { existsSync, statSync } from 'node:fs'
import { exec, truncate } from '../mac/exec'
import { expandHome } from '../mac/stats'
import type { ToolDef } from './types'

const NOISE = ['/System/', '/private/', '/usr/', '/Library/Caches/', '/.Trash/']

interface FileFacts {
  path: string
  size: number
  modified: number
  file: boolean
}

/** Spotlight returns paths only; size and age are what the question asks for. */
function describe(path: string): FileFacts {
  try {
    const stats = statSync(path)
    return { path, size: stats.size, modified: stats.mtimeMs, file: stats.isFile() }
  } catch {
    return { path, size: 0, modified: 0, file: false }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(0)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function formatWhen(at: number): string {
  if (!at) return 'unknown'
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export const fileTools: ToolDef[] = [
  {
    name: 'find_files',
    description:
      'Search this Mac for files by name using Spotlight. Returns each path with its size and modification time, newest first — enough to answer "what is my latest screenshot and how big is it" without opening it. Good before opening a document.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'File name or fragment to look for, e.g. "screenshot".' },
        limit: { type: 'integer', description: 'Maximum results (default 8, max 20).', minimum: 1, maximum: 20 }
      },
      required: ['query']
    },
    async run(args) {
      const query = String(args.query ?? '').trim().replace(/["\\]/g, '')
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)))
      const result = await exec('/usr/bin/mdfind', ['-name', query], { timeout: 6_000 })
      const files = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !NOISE.some((prefix) => line.includes(prefix)))
        .map((path) => describe(path))
        // `mdfind -name screenshot` also matches a folder called "screenshots";
        // reporting a directory as the file they asked about is wrong.
        .filter((file) => file.file)
        .sort((a, b) => b.modified - a.modified)
        .slice(0, limit)
      if (files.length === 0) {
        return { content: `No files matching "${query}".`, summary: `no files: ${query}` }
      }
      return {
        content: files
          .map((file) => `${file.path} — ${formatBytes(file.size)}, modified ${formatWhen(file.modified)}`)
          .join('\n'),
        summary: `${files.length} files`,
        openChat: files.length > 3
      }
    }
  },
  {
    name: 'open_path',
    description: 'Open a file or folder in the default macOS application or Finder.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, or ~/relative path.' }
      },
      required: ['path']
    },
    async run(args) {
      const path = expandHome(String(args.path ?? '').trim())
      if (!existsSync(path)) {
        return { content: `There is no file at ${path}.`, summary: 'missing path' }
      }
      const result = await exec('/usr/bin/open', [path], { timeout: 6_000 })
      if (result.code !== 0) {
        return { content: `Could not open ${path}: ${truncate(result.stderr, 160)}`, summary: 'open failed' }
      }
      return { content: `Opened ${path}.`, summary: `open ${path.split('/').pop()}` }
    }
  },
  {
    name: 'quick_look',
    description: 'Open a file in Quick Look, the macOS preview panel.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to preview.' }
      },
      required: ['path']
    },
    async run(args) {
      const path = expandHome(String(args.path ?? '').trim())
      if (!existsSync(path)) return { content: `No file at ${path}.`, summary: 'missing path' }
      const result = await exec('/usr/bin/qlmanage', ['-p', path], { timeout: 5_000 })
      if (result.code !== 0) {
        return { content: `Quick Look failed: ${truncate(result.stderr, 160)}`, summary: 'preview failed' }
      }
      return { content: `Previewing ${path}.`, summary: 'preview' }
    }
  }
]
