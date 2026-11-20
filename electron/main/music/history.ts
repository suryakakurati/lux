import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logLine } from '../log'

/**
 * What this Mac already knows about the person's listening.
 *
 * Two local sources, both read-only:
 *  - Spotify's desktop play history: a binary cache that is really a list of
 *    `spotify:track:` and `spotify:playlist:` URIs, with repetition as a proxy
 *    for rotation;
 *  - the public embed page for each URI, which ships title, artist and album
 *    inline, so a URI can be given a name without an account.
 *
 * Everything resolved is cached for 30 days in `userData/cache/spotify-meta.json`.
 */

export interface TrackMeta {
  title: string
  artist: string
  album?: string
  at: number
}

export interface HistoryEntry {
  uri: string
  kind: 'track' | 'playlist'
  count: number
}

type MetaCache = Record<string, TrackMeta>

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export function cacheFile(): string {
  return join(app.getPath('userData'), 'cache', 'spotify-meta.json')
}

export function readCache(): MetaCache {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), 'utf8')) as MetaCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeCache(cache: MetaCache): void {
  try {
    const file = cacheFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cache))
  } catch {
    /* a cache is an optimisation, never a dependency */
  }
}

/** Keep a resolved name so the next request for it works with no network. */
export function remember(uri: string, meta: Omit<TrackMeta, 'at'>): void {
  const cache = readCache()
  cache[uri] = { ...meta, at: Date.now() }
  writeCache(cache)
}

export function labelFor(uri: string, fallback: string): string {
  const meta = readCache()[uri]
  if (!meta) return fallback
  return meta.artist ? `${meta.title} — ${meta.artist}` : meta.title
}

function decode(value: string): string {
  return value
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n|\\t/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** Name a URI from its public embed page. No login, no token. */
async function resolveUri(uri: string): Promise<TrackMeta | null> {
  const [, kind, id] = uri.split(':')
  if (!kind || !id) return null
  try {
    const response = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(4_000)
    })
    if (!response.ok) return null
    const html = await response.text()
    const title = /"(?:title|name)":"([^"]{1,140})"/.exec(html)?.[1]
    if (!title) return null

    let artist = ''
    if (kind === 'track') {
      const block = /"artists":\[([\s\S]{0,800}?)\]/.exec(html)?.[1] ?? ''
      artist = [...block.matchAll(/"name":"([^"]+)"/g)].map((match) => match[1]).join(', ')
    } else if (kind === 'playlist') {
      artist = /"subtitle":"([^"]{1,80})"/.exec(html)?.[1] ?? ''
    }

    const clean = decode(title).replace(/[\\\s]+$/, '').slice(0, 90)
    return { title: clean, artist: decode(artist), at: Date.now() }
  } catch {
    return null
  }
}

/** Resolve many URIs in parallel, bounded, reusing the on-disk cache. */
export async function resolveAll(uris: string[]): Promise<Map<string, TrackMeta>> {
  const cache = readCache()
  const result = new Map<string, TrackMeta>()
  const missing: string[] = []

  for (const uri of uris) {
    const hit = cache[uri]
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) result.set(uri, hit)
    else missing.push(uri)
  }

  const settled = await Promise.all(
    missing.slice(0, 18).map(async (uri) => ({ uri, meta: await resolveUri(uri) }))
  )
  let dirty = false
  for (const { uri, meta } of settled) {
    if (!meta) continue
    result.set(uri, meta)
    cache[uri] = meta
    dirty = true
  }
  if (dirty) writeCache(cache)
  return result
}

/** Play history is a binary cache; frequency stands in for "in rotation". */
export function readPlayHistory(): HistoryEntry[] {
  const base = join(homedir(), 'Library', 'Application Support', 'Spotify', 'PersistentCache', 'Users')
  if (!existsSync(base)) return []

  const counts = new Map<string, HistoryEntry>()
  let users: string[] = []
  try {
    users = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name))
  } catch {
    return []
  }

  for (const userDir of users) {
    const file = join(userDir, 'list_player_play_history')
    if (!existsSync(file)) continue
    let text = ''
    try {
      // latin1 keeps every byte and lets the URI regex work on binary safely.
      text = readFileSync(file, 'latin1')
    } catch {
      continue
    }
    for (const match of text.matchAll(/spotify:(track|playlist):([A-Za-z0-9]+)/g)) {
      const kind = match[1] as 'track' | 'playlist'
      const uri = `spotify:${kind}:${match[2]}`
      const existing = counts.get(uri)
      if (existing) existing.count += 1
      else counts.set(uri, { uri, kind, count: 1 })
    }
  }

  return [...counts.values()].sort((a, b) => b.count - a.count)
}

/**
 * Turn the tracks this Mac has already played into names, a dozen at a time.
 *
 * The play history is nothing but URIs, so this is what makes "play Sweater
 * Weather" work for a song played a hundred times with no account and no key.
 */
export async function resolveHistoryNames(limit = 12): Promise<number> {
  const cache = readCache()
  const missing = readPlayHistory()
    .filter((entry) => entry.kind === 'track')
    .map((entry) => entry.uri)
    .filter((uri) => !cache[uri])
    .slice(0, limit)
  if (missing.length === 0) return 0
  await resolveAll(missing)
  logLine('music', `history names resolved=${missing.length}`)
  return missing.length
}
