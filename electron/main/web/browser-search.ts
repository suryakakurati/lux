import { app, BrowserWindow, session } from 'electron'
import { logLine } from '../log'
import type { SearchHit } from './search'

/**
 * Search rendered in the app's own Chromium.
 *
 * The HTTP providers are fast, but they are also fingerprintable: search.brave.com
 * answers a plain Node fetch with 429 and a CAPTCHA page while the same URL in a
 * real browser answers 200. That is invisible from inside the app — it looks
 * like "no results" — and it is exactly the failure where a person finds the
 * answer on the first result and Lux says it could not.
 *
 * So when the HTTP pass yields nothing, the same query is loaded in a hidden
 * Chromium window on its own partition and the DOM is read. This is the same
 * approach Spotify lookups already use, and it keeps the page out of the
 * person's own browser session.
 */

// A version suffix matters: a partition that ever received a 429 challenge keeps
// serving a block page for every later query (title "Brave Search", zero rows).
const PARTITION = 'persist:lux-search-2'
const LOAD_TIMEOUT_MS = 10_000
const POLL_TIMEOUT_MS = 6_000
const BRAVE_URL = (encoded: string): string => `https://search.brave.com/search?q=${encoded}&source=web`
const DDG_URL = (encoded: string): string => `https://html.duckduckgo.com/html/?q=${encoded}`
const POLL_MS = 300
const MAX_ROWS = 20

let window: BrowserWindow | null = null
/** One page at a time: two searches would navigate the same window under each other. */
let queue: Promise<unknown> = Promise.resolve()

interface RawHit {
  title: string
  url: string
  snippet: string
}

const BRAVE_EXTRACT = `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  const out = []
  for (const block of document.querySelectorAll('[data-type="web"], .snippet')) {
    const link = block.querySelector('a[href^="http"]')
    if (!link) continue
    const titleNode = block.querySelector('.title')
    const descNode = block.querySelector('.description')
    const title = clean(titleNode ? titleNode.innerText : link.innerText)
    if (!title) continue
    out.push({
      title: title.slice(0, 180),
      url: link.href,
      snippet: clean(descNode ? descNode.innerText : '').slice(0, 360)
    })
    if (out.length >= ${MAX_ROWS}) break
  }
  return out
})()`

// DuckDuckGo's server-rendered page links through its own redirector
// (//duckduckgo.com/l/?uddg=...), so the href is relative and must be unwrapped.
const DDG_EXTRACT = `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  const target = (href) => {
    try {
      const url = new URL(href || '', location.href)
      const wrapped = url.searchParams.get('uddg')
      return wrapped ? decodeURIComponent(wrapped) : url.href
    } catch (error) {
      return ''
    }
  }
  const out = []
  for (const block of document.querySelectorAll('.result')) {
    const link = block.querySelector('.result__a') || block.querySelector('a[href]')
    if (!link) continue
    const url = target(link.getAttribute('href'))
    if (!/^https?:/i.test(url)) continue
    const title = clean(link.innerText)
    if (!title) continue
    const snippetNode = block.querySelector('.result__snippet')
    out.push({
      title: title.slice(0, 180),
      url,
      snippet: clean(snippetNode ? snippetNode.innerText : '').slice(0, 360)
    })
    if (out.length >= ${MAX_ROWS}) break
  }
  return out
})()`

function ensureWindow(): BrowserWindow | null {
  if (!app.isReady()) return null
  if (window && !window.isDestroyed()) return window
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      partition: PARTITION,
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

async function load(win: BrowserWindow, url: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      win
        .loadURL(url)
        .then(() => true)
        .catch((error) => {
          logLine('search-web', `load failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }),
      timeout
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function cleanHits(rows: RawHit[]): RawHit[] {
  const seen = new Set<string>()
  const out: RawHit[] = []
  for (const row of rows) {
    if (!row.title || !/^https?:\/\//i.test(row.url)) continue
    try {
      const url = new URL(row.url)
      url.hash = ''
      const key = url.toString()
      if (seen.has(key)) continue
      if (/(^|\.)(search\.brave\.com|duckduckgo\.com)$/i.test(url.hostname)) continue
      seen.add(key)
      out.push({ title: row.title, url: key, snippet: row.snippet })
    } catch {
      continue
    }
  }
  return out
}

/** Load one search page and read its result blocks, waiting for client render. */
async function attempt(
  win: BrowserWindow,
  url: string,
  script: string,
  provider: 'brave' | 'web',
  blockTitle?: string
): Promise<SearchHit[]> {
  const loaded = await load(win, url)
  if (!loaded) return []
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return []
    // A challenge page is titled with the engine name alone; bail in ~1s instead
    // of polling a page that will never grow results.
    if (blockTitle) {
      const title = (await win.webContents
        .executeJavaScript('document.title', true)
        .catch(() => '')) as string
      if (typeof title === 'string' && title.trim() === blockTitle) return []
    }
    const rows = (await win.webContents.executeJavaScript(script, true).catch(() => [])) as RawHit[]
    const hits = cleanHits(Array.isArray(rows) ? rows : [])
    if (hits.length > 0) {
      return hits.map((hit) => ({ ...hit, provider }))
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return []
}

async function run(query: string, limit: number): Promise<SearchHit[]> {
  const win = ensureWindow()
  if (!win) return []
  const started = Date.now()
  const encoded = encodeURIComponent(query)

  const brave = await attempt(win, BRAVE_URL(encoded), BRAVE_EXTRACT, 'brave', 'Brave Search')
  if (brave.length > 0) {
    logLine('search-web', `brave render "${query.slice(0, 60)}" -> ${brave.length} in ${Date.now() - started}ms`)
    return brave.slice(0, limit)
  }

  // Engine order is worth keeping: lexical scoring fails on transliteration and
  // non-Latin script, so these are trusted in the order the engine returned them.
  const ddg = await attempt(win, DDG_URL(encoded), DDG_EXTRACT, 'brave')
  if (ddg.length > 0) {
    logLine('search-web', `ddg render "${query.slice(0, 60)}" -> ${ddg.length} in ${Date.now() - started}ms`)
    return ddg.slice(0, limit)
  }

  // Both engines empty is usually a stale challenge cookie, not an empty web.
  // Clear the search jar once and try the stronger engine again.
  await clearSearchSession()
  const retried = await attempt(win, BRAVE_URL(encoded), BRAVE_EXTRACT, 'brave', 'Brave Search')
  if (retried.length > 0) {
    logLine('search-web', `brave render retry "${query.slice(0, 60)}" -> ${retried.length} in ${Date.now() - started}ms`)
    return retried.slice(0, limit)
  }
  // The title is the cheapest way to tell a block page from a genuinely empty
  // result set when neither engine yields rows.
  const title = win.isDestroyed() ? '' : win.webContents.getTitle()
  logLine(
    'search-web',
    `render "${query.slice(0, 60)}" -> brave 0, ddg ${ddg.length} in ${Date.now() - started}ms title=${JSON.stringify(title.slice(0, 80))}`
  )
  return []
}

async function clearSearchSession(): Promise<void> {
  try {
    await session.fromPartition(PARTITION).clearStorageData()
  } catch (error) {
    logLine('search-web', `clear failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Serialised rendered search. Returns [] when the page cannot be read. */
export function searchWebInBrowser(query: string, limit = 8): Promise<SearchHit[]> {
  const job = queue.then(
    () => run(query, limit),
    () => run(query, limit)
  )
  queue = job.catch(() => undefined)
  return job
}

export function disposeSearchWindow(): void {
  if (window && !window.isDestroyed()) window.destroy()
  window = null
}
