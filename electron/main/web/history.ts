import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { querySqlite, sqlLike } from '../mac/sqlite'

export type HistoryBrowser = 'auto' | 'firefox' | 'chrome' | 'safari'

export interface HistoryHit {
  title: string
  url: string
  visits: number
  last: string
  browser: string
}

export interface HistoryResult {
  hits: HistoryHit[]
  notes: string[]
}

const HOME = homedir()

function firefoxDatabases(): string[] {
  const root = join(HOME, 'Library/Application Support/Firefox/Profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((profile) => join(root, profile, 'places.sqlite'))
    .filter((path) => existsSync(path))
}

function chromeDatabases(): string[] {
  const root = join(HOME, 'Library/Application Support/Google/Chrome')
  return ['Default', 'Profile 1', 'Profile 2', 'Profile 3']
    .map((profile) => join(root, profile, 'History'))
    .filter((path) => existsSync(path))
}

function safariDatabase(): string {
  return join(HOME, 'Library/Safari/History.db')
}

/**
 * Search where the person has actually been.
 *
 * Firefox stores URLs and titles in `moz_places` with one row per visit in
 * `moz_historyvisits`; Chrome keeps a single `urls` table with a visit count and
 * a WebKit-epoch timestamp; Safari splits items from visits and uses Apple's
 * 2001 epoch. All three are normalised into the same shape here.
 */
export async function searchHistory(
  query: string,
  limit = 8,
  only: HistoryBrowser = 'auto'
): Promise<HistoryResult> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return { hits: [], notes: ['Query too short.'] }

  const like = sqlLike(trimmed)
  const notes: string[] = []
  const hits: HistoryHit[] = []
  const wantFirefox = only === 'auto' || only === 'firefox'
  const wantChrome = only === 'auto' || only === 'chrome'
  const wantSafari = only === 'auto' || only === 'safari'

  const firefoxSql = `
    SELECT coalesce(p.title, ''), p.url, COUNT(h.id),
           strftime('%Y-%m-%d %H:%M', MAX(h.visit_date) / 1000000, 'unixepoch', 'localtime')
    FROM moz_places p
    LEFT JOIN moz_historyvisits h ON h.place_id = p.id
    WHERE (lower(p.url) LIKE lower('${like}') OR lower(coalesce(p.title, '')) LIKE lower('${like}'))
      AND p.url NOT LIKE 'place:%'
    GROUP BY p.id
    ORDER BY COUNT(h.id) DESC, MAX(h.visit_date) DESC
    LIMIT ${limit * 2}`

  const chromeSql = `
    SELECT coalesce(title, ''), url, visit_count,
           strftime('%Y-%m-%d %H:%M', (last_visit_time / 1000000) - 11644473600, 'unixepoch', 'localtime')
    FROM urls
    WHERE (lower(url) LIKE lower('${like}') OR lower(coalesce(title, '')) LIKE lower('${like}'))
    ORDER BY visit_count DESC, last_visit_time DESC
    LIMIT ${limit * 2}`

  const safariSql = `
    SELECT coalesce(i.title, ''), i.url, COUNT(v.id),
           strftime('%Y-%m-%d %H:%M', MAX(v.visit_time) + 978307200, 'unixepoch', 'localtime')
    FROM history_items i
    LEFT JOIN history_visits v ON v.history_item = i.id
    WHERE (lower(i.url) LIKE lower('${like}') OR lower(coalesce(i.title, '')) LIKE lower('${like}'))
    GROUP BY i.id
    ORDER BY COUNT(v.id) DESC, MAX(v.visit_time) DESC
    LIMIT ${limit * 2}`

  const collect = async (databases: string[], sql: string, browser: string): Promise<void> => {
    if (databases.length === 0) {
      notes.push(`No ${browser} history found.`)
      return
    }
    for (const database of databases) {
      const result = await querySqlite(database, sql)
      if (result.error) {
        notes.push(`${browser} history unreadable: ${result.error}`)
        continue
      }
      for (const row of result.rows) {
        hits.push({
          title: row[0] ?? '',
          url: row[1] ?? '',
          visits: Number(row[2] ?? 0),
          last: row[3] ?? '',
          browser
        })
      }
    }
  }

  if (wantFirefox) await collect(firefoxDatabases(), firefoxSql, 'Firefox')
  if (wantChrome) await collect(chromeDatabases(), chromeSql, 'Chrome')
  if (wantSafari) {
    const database = safariDatabase()
    if (existsSync(database)) await collect([database], safariSql, 'Safari')
    else if (only === 'safari') notes.push('Safari history is not available.')
  }

  // One row per URL: the highest visit count wins, then recency.
  const best = new Map<string, HistoryHit>()
  for (const hit of hits) {
    if (!hit.url) continue
    const existing = best.get(hit.url)
    if (!existing || hit.visits > existing.visits) best.set(hit.url, hit)
  }

  const ranked = [...best.values()]
    .sort((a, b) => b.visits - a.visits || b.last.localeCompare(a.last))
    .slice(0, limit)

  if (ranked.length === 0) notes.push(`Nothing in history matches "${trimmed}".`)
  return { hits: ranked, notes }
}

/**
 * The sites this Mac actually uses, most visited first.
 *
 * A vague request ("any assignments due?") has no searchable words, so an empty
 * history_search falls back to this: it is the difference between the model
 * finding the course portal and claiming it cannot see anything.
 */
export async function topSites(limit = 12): Promise<HistoryHit[]> {
  const perPlace = limit * 8
  const firefoxSql = `
    SELECT coalesce(p.title, ''), p.url, COUNT(h.id),
           strftime('%Y-%m-%d %H:%M', MAX(h.visit_date) / 1000000, 'unixepoch', 'localtime')
    FROM moz_places p JOIN moz_historyvisits h ON h.place_id = p.id
    WHERE p.url LIKE 'http%'
    GROUP BY p.id ORDER BY COUNT(h.id) DESC LIMIT ${perPlace}`
  const chromeSql = `
    SELECT coalesce(title, ''), url, visit_count,
           strftime('%Y-%m-%d %H:%M', (last_visit_time / 1000000) - 11644473600, 'unixepoch', 'localtime')
    FROM urls WHERE url LIKE 'http%'
    ORDER BY visit_count DESC LIMIT ${perPlace}`

  const rows: HistoryHit[] = []
  const sources = [
    ...firefoxDatabases().map((database) => ({ database, sql: firefoxSql, browser: 'Firefox' })),
    ...chromeDatabases().map((database) => ({ database, sql: chromeSql, browser: 'Chrome' }))
  ]
  for (const source of sources) {
    const result = await querySqlite(source.database, source.sql)
    for (const row of result.rows) {
      rows.push({
        title: row[0] ?? '',
        url: row[1] ?? '',
        visits: Number(row[2] ?? 0),
        last: row[3] ?? '',
        browser: source.browser
      })
    }
  }

  // One entry per site, keeping the busiest page, so the list reads as places
  // rather than twelve tabs from the same portal.
  const bySite = new Map<string, HistoryHit>()
  for (const hit of rows) {
    let site: string
    try {
      site = new URL(hit.url).hostname.replace(/^www\./, '')
    } catch {
      continue
    }
    const existing = bySite.get(site)
    if (!existing || hit.visits > existing.visits) bySite.set(site, hit)
  }

  return [...bySite.values()].sort((a, b) => b.visits - a.visits).slice(0, limit)
}

