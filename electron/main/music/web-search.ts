import { app, BrowserWindow } from 'electron'
import { logLine } from '../log'
import {
  parseSearchRows,
  pickBestTrack,
  searchTerm,
  type SpotifyTrack,
  type TrackQuery
} from '../../../shared/spotify'

/**
 * Spotify search without an account, a token or a developer app.
 *
 * `play track` needs a URI, and the Web API is closed to development-mode apps
 * whose owner does not have Premium ("Active premium subscription required for
 * the owner of the app"). The public search page, however, is ordinary web
 * content: rendering it in a hidden Chromium window yields real track links,
 * because the page's own JavaScript calls Spotify's internal search.
 *
 * That is the reliable route on a free account. It needs no login, no cookies
 * and no key, and it returns exactly what the person would see in the app.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** A page load plus hydration. Slow network still gets a chance. */
const LOAD_TIMEOUT_MS = 12_000
const DOM_TIMEOUT_MS = 9_000
const POLL_MS = 300

export type WebSearchReason = 'empty' | 'timeout' | 'unavailable'

export interface WebSearchResult {
  tracks: SpotifyTrack[]
  reason?: WebSearchReason
}

let window: BrowserWindow | null = null
/** One page at a time: parallel navigation in one window would race itself. */
let queue: Promise<unknown> = Promise.resolve()
const memory = new Map<string, SpotifyTrack[]>()

function ensureWindow(): BrowserWindow | null {
  if (!app.isReady()) return null
  if (window && !window.isDestroyed()) return window
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      // A separate, persistent partition keeps search cookies away from the
      // person's browsing session while still remembering any consent choice.
      partition: 'persist:lux-spotify-search',
      backgroundThrottling: false,
      sandbox: true,
      javascript: true
    }
  })
  window.on('closed', () => {
    window = null
  })
  return window
}

/** The DOM shape the search page renders; kept in one place so it is easy to repair. */
const EXTRACT = `(() => {
  const rows = []
  for (const anchor of document.querySelectorAll('a[href*="/track/"]')) {
    const href = anchor.getAttribute('href') || ''
    const title = (anchor.textContent || '').trim()
    if (!href || !title) continue
    let row = anchor.closest('[data-testid="tracklist-row"]')
    if (!row) {
      // The row wrapper is not stable across redesigns; walk up until a block
      // contains an artist link as well as the track link.
      let node = anchor.parentElement
      for (let depth = 0; node && depth < 6; depth += 1) {
        if (node.querySelector('a[href*="/artist/"]')) { row = node; break }
        node = node.parentElement
      }
    }
    const artistLink = row ? row.querySelector('a[href*="/artist/"]') : null
    rows.push({
      href,
      title,
      artist: artistLink ? (artistLink.textContent || '').trim() : ''
    })
    if (rows.length >= 40) break
  }
  return rows
})()`

async function waitForRows(win: BrowserWindow): Promise<ReturnType<typeof parseSearchRows>> {
  const deadline = Date.now() + DOM_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return []
    const rows = (await win.webContents
      .executeJavaScript(EXTRACT, true)
      .catch(() => [])) as { href: string; title: string; artist: string }[]
    if (rows.length > 0) return parseSearchRows(rows)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return []
}

async function load(win: BrowserWindow, url: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([
      win
        .loadURL(url, { userAgent: UA })
        .then(() => true)
        .catch((error) => {
          logLine('spotify-web', `load failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }),
      timeout
    ])
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function run(query: TrackQuery, limit: number): Promise<WebSearchResult> {
  const key = searchTerm(query)
  const cached = memory.get(key)
  if (cached) return { tracks: cached.slice(0, limit) }

  const win = ensureWindow()
  if (!win) return { tracks: [], reason: 'unavailable' }

  const url = `https://open.spotify.com/search/${encodeURIComponent(key)}/tracks`
  const started = Date.now()
  const loaded = await load(win, url)
  if (!loaded) {
    logLine('spotify-web', `timeout loading ${key}`)
    return { tracks: [], reason: 'timeout' }
  }

  const rows = await waitForRows(win)
  if (rows.length === 0) {
    logLine('spotify-web', `no rows for ${key} after ${Date.now() - started}ms`)
    return { tracks: [], reason: 'empty' }
  }

  // Spotify already ranked these; scoring only removes variants and wrong songs
  // when the query named an artist.
  const tracks = rows.filter((track) => track.uri)
  const best = pickBestTrack(query, tracks, 0.35)
  const ordered = best ? [best, ...tracks.filter((track) => track.uri !== best.uri)] : tracks
  memory.set(key, ordered)
  logLine(
    'spotify-web',
    `search "${key}" -> ${ordered.length} tracks in ${Date.now() - started}ms (top: ${ordered[0]?.name ?? 'none'})`
  )
  return { tracks: ordered.slice(0, limit) }
}

/**
 * Search Spotify's public library for a track name.
 *
 * Calls are serialised because they share one hidden page; concurrent callers
 * wait rather than navigating the same window from under each other.
 */
export function webSearchTracks(query: TrackQuery, limit = 8): Promise<WebSearchResult> {
  const job = queue.then(
    () => run(query, limit),
    () => run(query, limit)
  )
  queue = job.catch(() => undefined)
  return job
}

export function disposeWebSearch(): void {
  if (window && !window.isDestroyed()) window.destroy()
  window = null
}
