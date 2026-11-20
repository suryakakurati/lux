import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandHome } from '../mac/stats'
import { searchMarkdown } from '../mac/text-search'
import type { ToolDef } from './types'

function safeName(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function stamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const noteTools: ToolDef[] = [
  {
    name: 'write_note',
    description:
      'Save a markdown note on this Mac. Reuse an existing title to append to that note; leave the title out to append to today\u2019s daily note.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title. Omit for the daily note.' },
        body: { type: 'string', description: 'Markdown body of the note.' },
        append: { type: 'boolean', description: 'Append instead of overwriting (default true).' }
      },
      required: ['body']
    },
    async run(args, context) {
      const dir = expandHome(context.settings.notesDir)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const title = safeName(String(args.title ?? '')) || `Daily note ${stamp()}`
      const path = join(dir, `${title}.md`)
      const body = String(args.body ?? '').trim()
      const append = args.append !== false
      const header = `\n\n## ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}\n`
      if (append && existsSync(path)) {
        writeFileSync(path, `${readFileSync(path, 'utf8')}${header}${body}\n`, 'utf8')
        return { content: `Appended to ${path}.`, summary: `note: ${title}`, openChat: false }
      }
      writeFileSync(path, `# ${title}\n\n${body}\n`, 'utf8')
      return { content: `Saved note at ${path}.`, summary: `saved: ${title}`, openChat: false }
    }
  },
  {
    name: 'search_notes',
    description:
      'Search your Lux notes and (if configured) an Obsidian vault for a phrase. Returns matching files with a snippet.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Phrase to look for.' },
        limit: { type: 'integer', description: 'Maximum matches (default 5, max 12).', minimum: 1, maximum: 12 }
      },
      required: ['query']
    },
    async run(args, context) {
      const query = String(args.query ?? '').trim()
      const limit = Math.min(12, Math.max(1, Number(args.limit ?? 5)))
      if (query.length < 2) return { content: 'Query too short.', summary: 'query too short' }

      const roots = [expandHome(context.settings.notesDir)]
      if (context.settings.vaultPath) roots.push(expandHome(context.settings.vaultPath))
      const found = await searchMarkdown(
        roots.filter((root) => existsSync(root)),
        query,
        limit
      )

      if (found.length === 0) {
        return { content: `No notes mention "${query}".`, summary: 'no note matches' }
      }
      return {
        content: found.map((match) => `${match.title} — …${match.snippet}…`).join('\n\n'),
        summary: `${found.length} notes`,
        openChat: true
      }
    }
  },
  {
    name: 'remember',
    description:
      'Store a durable fact about the person (preferences, names, routines) that should be recalled in future conversations.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'A single, self-contained fact.' }
      },
      required: ['fact']
    },
    async run(args, context) {
      const fact = String(args.fact ?? '').trim()
      if (!fact) return { content: 'Nothing to remember.', summary: 'empty fact' }
      context.remember(fact)
      context.notify('Lux remembers', fact)
      return { content: `Remembered: ${fact}`, summary: 'remembered', openChat: false }
    }
  }
]
