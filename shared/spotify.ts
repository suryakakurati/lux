/**
 * Turning "Heat Waves — Glass Animals" into a track Spotify will actually play.
 *
 * Spotify's desktop app has no scripting command that searches: AppleScript can
 * only play a URI it is handed. So a name has to become a `spotify:track:` id
 * before anything can play, and there are only two honest sources for that:
 *
 *   - the local cache of ids this Mac has already resolved, and
 *   - Spotify's Web API search, which needs the person's own (free) app
 *     credential.
 *
 * Everything in this module is pure: scoring, parsing and the shape of a
 * search result. The network calls live in `electron/main/music/`.
 */

export interface SpotifyTrack {
  uri: string
  name: string
  artists: string[]
  album?: string
  durationMs: number
}

/** A name to look for, split into the parts that matter for matching. */
export interface TrackQuery {
  title: string
  artist?: string
}

/** A name already known locally (from the play-history cache). */
export interface Named {
  title: string
  artist: string
}

export interface TokenState {
  accessToken: string
  /** Epoch ms after which the token is worthless. */
  expiresAt: number
}

/** Variants that are the same song but not the version anyone asked for. */
const VARIANT =
  /\b(karaoke|tribute|cover|made famous|in the style of|sped up|speed up|slowed|reverb|8d|instrumental|piano version|lullaby|nightcore|remix)\b/i

const TRACK_URI = /^spotify:track:[A-Za-z0-9]{16,32}$/

export function isTrackUri(value: string): boolean {
  return TRACK_URI.test(value.trim())
}

/** Lowercased words, punctuation gone, so `Don't` and `Dont` compare equal. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** Share of the longer name's words that both names have. */
function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let hits = 0
  for (const word of a) if (setB.has(word)) hits += 1
  return hits / Math.max(a.length, b.length)
}

function variantPenalty(name: string): number {
  return VARIANT.test(name) ? 0.35 : 0
}

/**
 * How well a candidate answers the query, 0…1.1.
 *
 * Title carries most of the weight, the artist settles ties, and an exact title
 * beats a partial one so "Heat Waves" prefers the song over "Heat Waves (Live)".
 */
export function scoreName(query: TrackQuery, candidate: Named): number {
  const titleA = words(query.title)
  const titleB = words(candidate.title)
  if (titleA.length === 0 || titleB.length === 0) return 0

  const titleScore = overlap(titleA, titleB)
  const exact = titleA.join(' ') === titleB.join(' ') ? 1 : 0
  const artistA = query.artist ? words(query.artist) : []
  // With no artist in the query, matching an artist cannot help or hurt.
  const artistScore = artistA.length > 0 ? overlap(artistA, words(candidate.artist)) : 0.5

  return Math.max(0, titleScore * 0.6 + artistScore * 0.4 + exact * 0.1 - variantPenalty(candidate.title))
}

export function scoreTrack(query: TrackQuery, track: SpotifyTrack): number {
  return scoreName(query, { title: track.name, artist: track.artists.join(' ') })
}

/** Best candidate above `min`, or null when nothing is close enough. */
export function pickBest<T>(
  query: TrackQuery,
  items: T[],
  score: (query: TrackQuery, item: T) => number,
  min: number
): T | null {
  let best: T | null = null
  let bestScore = 0
  for (const item of items) {
    const value = score(query, item)
    if (value > bestScore) {
      bestScore = value
      best = item
    }
  }
  return bestScore >= min ? best : null
}

export function pickBestTrack(query: TrackQuery, tracks: SpotifyTrack[], min = 0.45): SpotifyTrack | null {
  return pickBest(query, tracks, scoreTrack, min)
}

/**
 * One line from a model, a list from a person, or a pasted block: the pieces
 * that each describe a single track.
 *
 * Newlines and semicolons are unambiguous. Commas are only treated as a
 * separator when every comma-separated piece still reads like a name, so a
 * title with a comma in it survives.
 */
export function splitSpecs(raw: string): string[] {
  const byStrong = raw
    .split(/\n|;|\u2022/)
    .map((part) => part.trim())
    .filter(Boolean)
  const pieces = byStrong.flatMap((part) => {
    const byComma = part.split(',').map((piece) => piece.trim())
    if (byComma.length <= 1) return [part]
    // "Sunflower — Post Malone, Swae Lee" is one track; "A, B" is two.
    const looksLikeTrack = byComma.filter((piece) => /[\u2013\u2014-]|\bby\b/i.test(piece))
    // Only split on commas when several pieces independently look like a track.
    return looksLikeTrack.length >= 2 ? byComma : [part]
  })
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of pieces) {
    const key = piece.toLowerCase()
    if (!piece || seen.has(key)) continue
    seen.add(key)
    out.push(piece.length > 160 ? piece.slice(0, 160) : piece)
    if (out.length >= 20) break
  }
  return out
}

/**
 * Split a written name into title and artist.
 *
 * "Heat Waves — Glass Animals", "Heat Waves - Glass Animals" and "Heat Waves by
 * Glass Animals" all mean the same thing, and a bare title is fine too.
 */
export function parseTrackSpec(raw: string): TrackQuery | null {
  const text = raw
    .trim()
    .replace(/^\d{1,2}[.)]\s*/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^\s*[-•]\s*/, '')
    .trim()
  if (text.length < 2) return null

  const by = /^(.*\S)\s+by\s+(.+)$/i.exec(text)
  if (by) return { title: unquote(by[1]), artist: unquote(by[2]) }

  const dash = /^(.*\S)\s+[\u2013\u2014-]\s+(.+)$/.exec(text)
  if (dash) return { title: unquote(dash[1]), artist: unquote(dash[2]) }

  return { title: unquote(text) }
}

/** A title written in quotes keeps them until the very edges are trimmed. */
function unquote(text: string): string {
  return text.replace(/^[\s"'“”]+|[\s"'“”]+$/g, '').trim()
}

export function describeQuery(query: TrackQuery): string {
  return query.artist ? `${query.title} — ${query.artist}` : query.title
}

/** Search term for the Web API. Quoting a title keeps "Bones" out of the noise. */
export function searchTerm(query: TrackQuery): string {
  return query.artist ? `${query.title} ${query.artist}` : query.title
}

/**
 * Read `GET /v1/search?type=track` defensively: any item without a usable id is
 * dropped rather than allowed to poison the list.
 */
export function parseTrackSearch(payload: unknown): SpotifyTrack[] {
  const items = (payload as { tracks?: { items?: unknown } } | null)?.tracks?.items
  if (!Array.isArray(items)) return []

  const out: SpotifyTrack[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const uri = typeof record.uri === 'string' ? record.uri : ''
    if (!isTrackUri(uri)) continue
    const name = typeof record.name === 'string' ? record.name : ''
    if (!name) continue
    const artists = Array.isArray(record.artists)
      ? record.artists
          .map((artist) =>
            artist && typeof artist === 'object' ? (artist as { name?: unknown }).name : undefined
          )
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
      : []
    const album =
      record.album && typeof record.album === 'object'
        ? (record.album as { name?: unknown }).name
        : undefined
    out.push({
      uri,
      name,
      artists,
      album: typeof album === 'string' ? album : undefined,
      durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : 0
    })
  }
  return out
}

/**
 * Rows scraped from the rendered search page.
 *
 * The page exposes anchors like `/track/3USxtqRwSYz57Ewm6wWRMp`; this turns them
 * into the same shape the Web API returns, so matching code has one input type.
 * Anything without a plausible id is dropped rather than allowed to poison the
 * list, and duplicates are collapsed because the page repeats a track in
 * several sections.
 */
export function parseSearchRows(
  rows: { href?: string | null; title?: string | null; artist?: string | null }[]
): SpotifyTrack[] {
  const seen = new Set<string>()
  const out: SpotifyTrack[] = []
  for (const row of rows) {
    const href = (row.href ?? '').trim()
    const match = /\/track\/([A-Za-z0-9]{16,32})/.exec(href)
    if (!match) continue
    const uri = `spotify:track:${match[1]}`
    if (seen.has(uri)) continue
    const title = (row.title ?? '').trim()
    if (!title) continue
    const artist = (row.artist ?? '').trim()
    seen.add(uri)
    out.push({ uri, name: title, artists: artist ? [artist] : [], durationMs: 0 })
  }
  return out
}

/** A cached token is used until a minute before it dies, never at the edge. */
export function tokenUsable(state: TokenState | null | undefined, now = Date.now(), skewMs = 60_000): boolean {
  if (!state || !state.accessToken) return false
  return state.expiresAt - skewMs > now
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
