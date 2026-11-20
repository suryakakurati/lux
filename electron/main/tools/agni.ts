import { existsSync } from 'node:fs'
import { expandHome } from '../mac/stats'
import { querySqlite, sqlLike } from '../mac/sqlite'
import type { ToolDef } from './types'

function configuredPath(context: { settings: { agniDbPath: string } }): string {
  return expandHome(context.settings.agniDbPath.trim())
}

function notConfigured(): { content: string; summary: string } {
  return {
    content:
      'No local knowledge database is configured. Set its path in Settings → Notes & memory to enable these tools.',
    summary: 'local knowledge not configured'
  }
}

function missingDatabase(path: string): { content: string; summary: string } {
  return {
    content: `The configured local knowledge database does not exist at ${path}.`,
    summary: 'local knowledge database missing'
  }
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * An optional local SQLite knowledge base: canonical events, evidence-scored
 * links between them, and investigation reports. Lux reads it read-only so a
 * question about recorded events is answered from work already done on this
 * Mac instead of a fresh guess. The path is configured by the person; these
 * tools are disabled until then.
 */
export const agniTools: ToolDef[] = [
  {
    name: 'agni_links',
    description:
      'Read the optional local knowledge database configured in Settings: recent events and the strongest evidence-scored connections between them. Use for "what is going on" questions when the person has configured it; otherwise say it is not configured.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic, country, actor or phrase to focus on. Omit for the current picture.' },
        limit: { type: 'integer', description: 'Events and links to return (default 6, max 12).', minimum: 1, maximum: 12 }
      }
    },
    async run(args, context) {
      const db = configuredPath(context)
      if (!db) return notConfigured()
      if (!existsSync(db)) return missingDatabase(db)
      const topic = String(args.topic ?? '').trim()
      const limit = Math.min(12, Math.max(1, Number(args.limit ?? 6)))
      const like = sqlLike(topic)

      const eventsSql = topic
        ? `SELECT title, coalesce(region, country, ''), coalesce(first_reported_at, ''), source_count, category
           FROM events
           WHERE lower(title) LIKE lower('${like}') OR lower(coalesce(description, '')) LIKE lower('${like}')
           ORDER BY first_reported_at DESC LIMIT ${limit}`
        : `SELECT title, coalesce(region, country, ''), coalesce(first_reported_at, ''), source_count, category
           FROM events ORDER BY first_reported_at DESC LIMIT ${limit}`

      const linksSql = topic
        ? `SELECT a.title, b.title, round(r.score, 2), coalesce(r.types, ''), coalesce(r.evidence, '')
           FROM relationships r
           JOIN events a ON a.id = r.a_event_id
           JOIN events b ON b.id = r.b_event_id
           WHERE lower(a.title) LIKE lower('${like}') OR lower(b.title) LIKE lower('${like}')
              OR lower(coalesce(a.description, '')) LIKE lower('${like}')
              OR lower(coalesce(b.description, '')) LIKE lower('${like}')
           ORDER BY r.score DESC LIMIT ${limit}`
        : `SELECT a.title, b.title, round(r.score, 2), coalesce(r.types, ''), coalesce(r.evidence, '')
           FROM relationships r
           JOIN events a ON a.id = r.a_event_id
           JOIN events b ON b.id = r.b_event_id
           ORDER BY r.score DESC, r.updated_at DESC LIMIT ${limit}`

      const events = await querySqlite(db, eventsSql)
      const links = await querySqlite(db, linksSql)
      if (events.error && links.error) {
        return { content: `The local knowledge database could not be read: ${events.error}`, summary: 'local knowledge unreadable' }
      }

      const eventLines = events.rows.map((row, index) => {
        const [, region, reported, sources, category] = row
        const when = reported ? reported.slice(0, 16).replace('T', ' ') : 'time unknown'
        return `${index + 1}. ${clip(row[0] ?? '', 160)}\n   ${[category, region].filter(Boolean).join(' · ') || 'uncategorised'} · first reported ${when} · ${sources ?? 0} sources`
      })

      const linkLines = links.rows.map((row, index) => {
        const [a, b, score, types, evidence] = row
        const evidenceText = evidence ? `\n   evidence: ${clip(evidence, 220)}` : ''
        return `${index + 1}. ${clip(a ?? '', 90)} ↔ ${clip(b ?? '', 90)} · score ${score}${types ? ` · ${types}` : ''}${evidenceText}`
      })

      const header = topic
        ? `Local knowledge — matches for "${topic}":`
        : 'Local knowledge — the current picture:'

      return {
        content: [
          header,
          '',
          events.rows.length ? 'Events:' : 'No matching events.',
          ...eventLines,
          '',
          links.rows.length ? 'Strongest scored connections:' : 'No scored connections for this.',
          ...linkLines
        ].join('\n'),
        summary: `${events.rows.length} events, ${links.rows.length} links`,
        openChat: true
      }
    }
  },
  {
    name: 'agni_report',
    description:
      'Read investigation reports from the optional local knowledge database configured in Settings. Use when the person asks what a cluster of events amounts to and the database is configured.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Words to match in an investigation. Omit for the latest reports.' },
        limit: { type: 'integer', description: 'How many reports (default 2, max 5).', minimum: 1, maximum: 5 }
      }
    },
    async run(args, context) {
      const db = configuredPath(context)
      if (!db) return notConfigured()
      if (!existsSync(db)) return missingDatabase(db)
      const topic = String(args.topic ?? '').trim()
      const limit = Math.min(5, Math.max(1, Number(args.limit ?? 2)))
      const like = sqlLike(topic)
      const sql = topic
        ? `SELECT title, classification, coalesce(summary, ''), coalesce(created_at, ''), event_count
           FROM investigations
           WHERE lower(title) LIKE lower('${like}') OR lower(coalesce(summary, '')) LIKE lower('${like}')
              OR lower(coalesce(body, '')) LIKE lower('${like}')
           ORDER BY created_at DESC LIMIT ${limit}`
        : `SELECT title, classification, coalesce(summary, ''), coalesce(created_at, ''), event_count
           FROM investigations ORDER BY created_at DESC LIMIT ${limit}`

      const result = await querySqlite(db, sql)
      if (result.error) return { content: `Local reports unreadable: ${result.error}`, summary: 'local knowledge unreadable' }
      if (result.rows.length === 0) {
        return {
          content: `The local knowledge database has no investigation matching "${topic || 'anything yet'}".`,
          summary: 'no local report'
        }
      }

      const blocks = result.rows.map((row, index) => {
        const [title, classification, summary, created, events] = row
        return [
          `${index + 1}. ${clip(title ?? '', 140)}`,
          `   ${classification || 'unclassified'} · ${events ?? 0} events · ${(created ?? '').slice(0, 16).replace('T', ' ')}`,
          `   ${clip(summary ?? '', 700)}`
        ].join('\n')
      })

      return {
        content: ['Local investigations on this Mac:', '', ...blocks].join('\n'),
        summary: `${result.rows.length} local reports`,
        openChat: true
      }
    }
  }
]
