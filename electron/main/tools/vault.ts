import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { detectObsidianVault } from '../mac/obsidian'
import { expandHome } from '../mac/stats'
import { searchMarkdown } from '../mac/text-search'
import type { ToolDef } from './types'

/** The configured vault, or the one Obsidian itself has open. */
export function vaultRoot(configured: string): string {
  const path = expandHome(configured || '')
  if (path && existsSync(path)) return path
  return detectObsidianVault()
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 2_000) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(dir, entry)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) walk(full, out, depth + 1)
    else if (entry.endsWith('.md') && info.size < 500_000) out.push(full)
  }
}

async function searchVault(
  root: string,
  query: string,
  limit: number
): Promise<{ title: string; path: string; snippet: string }[]> {
  const matches = await searchMarkdown([root], query, limit)
  return matches.map((match) => ({
    title: match.title,
    path: relative(root, match.path),
    snippet: match.snippet
  }))
}

export const vaultTools: ToolDef[] = [
  {
    name: 'vault_search',
    description:
      'Search the person’s Obsidian vault by phrase, title or tag and return matching notes with a snippet. Use it before saying you do not know something that might be written down.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Phrase, topic or note title.' },
        limit: { type: 'integer', description: 'How many notes (default 6, max 15).', minimum: 1, maximum: 15 }
      },
      required: ['query']
    },
    async run(args, context) {
      const root = vaultRoot(context.settings.vaultPath)
      if (!root) {
        return { content: 'No Obsidian vault was found on this Mac.', summary: 'no vault' }
      }
      const query = String(args.query ?? '').trim()
      if (query.length < 2) return { content: 'Query too short.', summary: 'query too short' }
      const limit = Math.min(15, Math.max(1, Number(args.limit ?? 6)))
      const matches = await searchVault(root, query, limit)
      if (matches.length === 0) {
        return { content: `No notes in ${basename(root)} mention "${query}".`, summary: 'no vault match' }
      }
      return {
        content: matches
          .map((match) => `${match.title}  (${match.path})\n   …${match.snippet}…`)
          .join('\n\n'),
        summary: `${matches.length} vault notes`,
        openChat: true
      }
    }
  },
  {
    name: 'vault_read',
    description: 'Read one note from the Obsidian vault in full (or by title). Returns its markdown and path.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Note title, filename or relative path inside the vault.' }
      },
      required: ['note']
    },
    async run(args, context) {
      const root = vaultRoot(context.settings.vaultPath)
      if (!root) return { content: 'No Obsidian vault was found on this Mac.', summary: 'no vault' }
      const wanted = String(args.note ?? '').trim()
      if (!wanted) return { content: 'Which note?', summary: 'no note given' }

      const files: string[] = []
      walk(root, files)
      const needle = wanted.toLowerCase().replace(/\.md$/, '')
      const exact = files.find((file) => basename(file, '.md').toLowerCase() === needle)
      const byPath = files.find((file) => relative(root, file).toLowerCase() === `${needle}.md`)
      const partial = files.find((file) => basename(file, '.md').toLowerCase().includes(needle))
      const file = exact ?? byPath ?? partial

      if (!file) {
        return { content: `No note called "${wanted}" in ${basename(root)}.`, summary: 'note not found' }
      }
      const content = readFileSync(file, 'utf8')
      return {
        content: `# ${relative(root, file)}\n\n${content.length > 12_000 ? `${content.slice(0, 12_000)}…` : content}`,
        summary: `read ${basename(file, '.md')}`,
        openChat: true
      }
    }
  },
  {
    name: 'vault_write',
    description:
      'Create or append to a markdown note in the Obsidian vault (not the Lux notes folder). Use for durable notes the person will browse in Obsidian.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title without .md.' },
        body: { type: 'string', description: 'Markdown body.' },
        append: { type: 'boolean', description: 'Append when the note exists (default true).' }
      },
      required: ['title', 'body']
    },
    async run(args, context) {
      const root = vaultRoot(context.settings.vaultPath)
      if (!root) return { content: 'No Obsidian vault was found on this Mac.', summary: 'no vault' }

      const title = String(args.title ?? '')
        .replace(/[/\\:*?"<>|#^[\]]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90)
      const body = String(args.body ?? '').trim()
      if (!title || !body) return { content: 'A title and a body are needed.', summary: 'incomplete note' }

      if (!existsSync(root)) mkdirSync(root, { recursive: true })
      const path = join(root, `${title}.md`)
      const append = args.append !== false
      if (append && existsSync(path)) {
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n\n${body}\n`, 'utf8')
        return { content: `Appended to ${title}.md in the vault.`, summary: `vault: ${title}`, openChat: false }
      }
      writeFileSync(path, `# ${title}\n\n${body}\n`, 'utf8')
      return { content: `Wrote ${title}.md to the vault.`, summary: `vault: ${title}`, openChat: false }
    }
  }
]
