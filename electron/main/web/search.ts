import { decodeEntities } from './read.ts'
import { TtlCache } from './cache.ts'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /**
   * brave: a real-browser result (best relevance); web: an RSS direct page;
   * news: a headline or snippet that may not open as an article.
   */
  provider?: 'web' | 'brave' | 'news'
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  fetchedAt: number
  cached: boolean
  /**
   * Every provider refused or was rate-limited, so an empty result proves
   * nothing about the web. Callers must not turn this into "it does not exist".
   */
  blocked?: boolean
}

const cache = new TtlCache<{ hits: SearchHit[]; at: number }>(64)
const TTL_MS = 8 * 60_000

/**
 * A rendered search, injected by the main process. The HTTP providers are
 * fingerprintable and answer 429 to a plain fetch; Chromium does not. Kept as
 * an injected function so this module stays free of Electron imports and the
 * tests keep running without a browser.
 */
export type SearchRender = (query: string, limit: number) => Promise<SearchHit[]>

let renderSearch: SearchRender | null = null

export function setSearchRender(render: SearchRender | null): void {
  renderSearch = render
}

// Search hosts answer a flagged client with 429 for several minutes. Remember it
// so a later search does not pay the same timeout again.
const BLOCK_BACKOFF_MS = 10 * 60_000
let braveBlockedUntil = 0
let renderBlockedUntil = 0
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Lux/0.1'
const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'can', 'could', 'would', 'should', 'will', 'with',
  'that', 'this', 'these', 'those', 'from', 'have', 'has', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'how', 'why', 'does', 'did', 'about', 'into', 'over', 'under',
  'please', 'tell', 'give', 'find', 'want', 'need', 'some', 'any', 'all', 'in', 'on', 'at',
  'of', 'to', 'is', 'are', 'be', 'by', 'or', 'as', 'an', 'it',
  // Question framing. Ranking on "wrote" was returning dictionary pages for
  // "who wrote the song Dynamite by BTS" instead of pages about the song.
  'wrote', 'written', 'write', 'writes', 'said', 'says', 'mean', 'means', 'called', 'named'
])

/**
 * Search without a browser session.
 *
 * Three providers run together: Brave's HTML results are the primary index
 * because they follow the whole query ("Dynamite BTS english translation
 * lyrics" returns Genius and LyricsTranslate), while Bing's RSS feed is the
 * keyless fallback and Google News supplies dated headlines. Bing on its own
 * drifts to the first loose term — the same query used to return an
 * encyclopedia article and a clothing shop — so its results are only used when
 * the stronger provider is unavailable, and everything is ranked against the
 * actual question terms.
 */
export async function searchWeb(query: string, limit = 8, fresh = false): Promise<SearchResult> {
  const clean = query.replace(/\s+/g, ' ').trim()
  if (clean.length < 2) return { query: clean, hits: [], fetchedAt: Date.now(), cached: false }

  const key = `${clean.toLowerCase()}::${limit}`
  if (!fresh) {
    const cached = cache.get(key)
    if (cached) {
      return { query: clean, hits: cached.hits, fetchedAt: cached.at, cached: true }
    }
  }

  const [braveResult, bing, news] = await Promise.allSettled([
    fetchBrave(clean, Math.min(12, Math.max(limit, 8))),
    fetchBing(clean, Math.min(20, Math.max(limit, 8))),
    fetchBingNews(clean, Math.min(limit, 8))
  ])
  const brave = braveResult.status === 'fulfilled' ? braveResult.value : []
  const rss = [
    ...(bing.status === 'fulfilled' ? bing.value : []),
    ...(news.status === 'fulfilled' ? news.value : [])
  ]
  // Brave's ordering is materially better when it answers. Mixing Bing's looser
  // matches back in pulls generic homepages into an otherwise good result set.
  let hits: SearchHit[] = brave.length >= Math.min(4, limit) ? brave : [...brave, ...rss]

  // No Brave hits usually means the HTTP endpoint was blocked, not that the web
  // has nothing. Render the same query in Chromium before falling back to an RSS
  // feed that returns unrelated pages for anything it does not understand.
  if (brave.length === 0 && renderSearch && Date.now() >= renderBlockedUntil) {
    const rendered = await renderSearch(clean, Math.min(12, Math.max(limit, 8))).catch(() => [])
    if (rendered.length > 0) hits = [...rendered, ...hits]
    else renderBlockedUntil = Date.now() + BLOCK_BACKOFF_MS
  }

  // If the literal query drifted, try the topic phrase by itself. This is the
  // difference between "local news" homepages and pages about local AI models.
  if (rankHits(hits, clean).length < Math.min(3, limit)) {
    const focused = focusQuery(clean)
    if (focused !== clean) {
      const [extra, extraNews] = await Promise.all([
        fetchBing(focused, Math.min(12, Math.max(limit, 8))).catch(() => []),
        fetchBingNews(focused, Math.min(limit, 8)).catch(() => [])
      ])
      hits = [...hits, ...extra, ...extraNews]
    }
  }

  // Google News is a snippet-only fallback: its redirect URLs are useful for
  // headlines, but not every one can be opened as an article page.
  if (rankHits(hits, clean).length < Math.min(3, limit)) {
    const extra = await fetchGoogleNews(clean, Math.min(limit, 8)).catch(() => [])
    if (extra.length > 0) {
      hits = [...hits, ...extra]
    }
  }

  // A long question can miss where its subject hits. Retry the first few terms.
  if (rankHits(hits, clean).length === 0) {
    const compact = compactQuery(clean)
    if (compact !== clean) {
      const [extra, extraNews] = await Promise.all([
        fetchBing(compact, Math.min(12, Math.max(limit, 8))).catch(() => []),
        fetchBingNews(compact, Math.min(limit, 8)).catch(() => [])
      ])
      hits = [...hits, ...extra, ...extraNews]
    }
  }

  let ranked = rankHits(dedupe(hits), clean).slice(0, limit)
  // Brave already ranked these, and lexical scoring fails on transliteration
  // and non-Latin script. Trust its order rather than returning nothing. The
  // RSS feeds never get this treatment: their results are unrelated pages.
  if (ranked.length === 0) {
    const rendered = dedupe(hits).filter((hit) => hit.provider === 'brave')
    if (rendered.length > 0) ranked = rendered.slice(0, limit)
  }
  const at = Date.now()
  cache.set(key, { hits: ranked, at }, TTL_MS)
  const blocked =
    ranked.length === 0 && (Date.now() < braveBlockedUntil || Date.now() < renderBlockedUntil)
  return { query: clean, hits: ranked, fetchedAt: at, cached: false, blocked }
}

/** Exported for tests: a stable relevance ordering with direct pages first. */
export function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return dedupe(hits)
  const contentTerms = new Set(
    terms.filter((term) => !/^(latest|new|news|recent|developments?|updates?|releases?|happening|today)$/i.test(term))
  )
  const wantsNews = /\b(latest|news|recent|developments?|updates?|releases?|happening|today)\b/i.test(query)
  return dedupe(hits)
    .map((hit) => {
      const title = hit.title.toLowerCase()
      const snippet = hit.snippet.toLowerCase()
      const host = safeHost(hit.url)
      let score = hit.provider === 'brave' ? 1 : hit.provider === 'web' ? 0.5 : wantsNews ? 2 : 0
      let contentMatches = 0
      const matched = new Set<string>()
      for (const term of terms) {
        if (title.includes(term)) {
          score += 3
          matched.add(term)
          if (contentTerms.has(term)) contentMatches += 1
        }
        if (snippet.includes(term)) {
          score += 1
          matched.add(term)
          if (contentTerms.has(term)) contentMatches += 1
        }
        if (host.includes(term)) {
          score += 1
          matched.add(term)
          if (contentTerms.has(term)) contentMatches += 1
        }
      }
      const bareHomepage = /^\/?$/.test(safePath(hit.url))
      // A result that shares no word with the question is not evidence, even
      // when the provider ranked it highly. News snippets must match the topic
      // words, not just the date words. A bare homepage is never evidence.
      if (matched.size === 0) score = 0
      else if (hit.provider === 'news' && contentMatches === 0) score = 0
      else if (bareHomepage && contentMatches === 0) score = 0
      return { hit, score, contentMatches }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || providerRank(a.hit) - providerRank(b.hit))
    .map((item) => item.hit)
}

/**
 * Turn a request-shaped phrase into a search query. "Find the english lyrics
 * translation of the song" is a request, not a query; leading politeness,
 * generic verbs and question framing only dilute the index. A stale year in a
 * "latest" query is a model habit, not a user constraint.
 */
export function normalizeSearchQuery(value: string, force = false): string {
  const clean = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:find(?: me)?|search(?: for)?|look up|google|show me|tell me|get me)\s+/i, '')
    // "who wrote the song X" is a question about X, not about the word "wrote".
    .replace(/^(?:who|what|when|where|why|how)\s+(?:wrote|writes|is|are|was|were|did|does|do|can|should|would|means?)\s+/i, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim()
  if (!clean) return value.replace(/\s+/g, ' ').trim()
  if (!force && !/\b(latest|recent|new|news|developments?|updates?|releases?)\b/i.test(clean)) return clean
  const year = new Date().getFullYear()
  return clean
    .replace(/\b(20\d{2})\b/g, (match) => (Number(match) < year ? '' : match))
    .replace(/\s+/g, ' ')
    .trim()
}

/** The phrase that should survive when a natural-language request drifts. */
export function focusQuery(query: string): string {
  const terms = searchTerms(query).filter(
    (term) => !/^(latest|new|news|recent|developments?|updates?|releases?|happening|today)$/i.test(term)
  )
  if (terms.length < 2) return query
  return `"${terms.slice(-4).join(' ')}"`
}

function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 2 && !STOP.has(word))
}

/**
 * Brave's public HTML results need no key and follow the whole query, which is
 * exactly where the RSS feeds fail. The parse is tolerant: an unfamiliar layout
 * yields no hits and the RSS providers take over.
 */
async function fetchBrave(query: string, limit: number): Promise<SearchHit[]> {
  if (Date.now() < braveBlockedUntil) return []
  const response = await fetch(
    `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(12_000)
    }
  )
  if (response.status === 429 || response.status === 403 || response.status === 503) {
    braveBlockedUntil = Date.now() + BLOCK_BACKOFF_MS
    throw new Error(`brave HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`brave HTTP ${response.status}`)
  const hits = parseBrave(await response.text(), limit)
  // A challenge page is served with 200 and no result blocks.
  if (hits.length === 0) braveBlockedUntil = Date.now() + BLOCK_BACKOFF_MS
  return hits
}

/**
 * The subject of a bloated request: its first few terms without the qualifiers
 * that made the query too specific for the RSS index.
 */
export function compactQuery(query: string): string {
  const terms = searchTerms(query).filter(
    (term) => !/^(english|translation|translate|translated|meaning|explain|explained)$/i.test(term)
  )
  if (terms.length < 2) return query
  return terms.slice(0, 4).join(' ')
}

/** Exported for tests: Brave result markup in, clean hits out. */
export function parseBrave(html: string, limit = 8): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const blocks = html.split(/<div class="snippet [^"]*"\s+data-pos=/).slice(1)
  for (const raw of blocks) {
    const block = raw.slice(0, 12_000)
    if (!/data-type="web"/.test(block.slice(0, 200))) continue
    const href = /<a\b[^>]*href="(https?:\/\/[^"]+)"/.exec(block)?.[1]
    if (!href) continue
    let url: URL
    try {
      url = new URL(decodeEntities(href))
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    if (/(^|\.)(search\.brave\.com|imgs\.search\.brave\.com)$/i.test(url.hostname)) continue
    url.hash = ''
    const key = url.toString()
    if (seen.has(key)) continue
    const title =
      taggedText(block, 'div', 'title') ||
      stripHtml(/<a\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '')
    if (!title) continue
    seen.add(key)
    hits.push({
      title: title.slice(0, 180),
      url: key,
      snippet: taggedText(block, 'div', 'description').slice(0, 360),
      provider: 'brave'
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** Text of the first element with a given class, stripped of markup. */
function taggedText(block: string, tag: string, className: string): string {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    'i'
  )
  return stripHtml(pattern.exec(block)?.[1] ?? '')
}

async function fetchBing(query: string, limit: number): Promise<SearchHit[]> {
  const xml = await fetchRss(
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&count=${limit}`
  )
  return parseRss(xml, limit).map((hit) => ({ ...hit, provider: 'web' as const }))
}

async function fetchBingNews(query: string, limit: number): Promise<SearchHit[]> {
  const xml = await fetchRss(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`)
  return parseRss(xml, limit).map((hit) => ({ ...hit, provider: 'news' as const }))
}

async function fetchGoogleNews(query: string, limit: number): Promise<SearchHit[]> {
  const xml = await fetchRss(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  )
  return parseRss(xml, limit).map((hit) => ({ ...hit, provider: 'news' as const }))
}

async function fetchRss(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,application/xml,text/xml' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`search HTTP ${response.status}`)
  return response.text()
}

/** Exported for tests: RSS in, clean search hits out. */
export function parseRss(xml: string, limit = 8): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const blocks = xml.split(/<item\b[^>]*>/i).slice(1)
  for (const block of blocks) {
    const title = textTag(block, 'title')
    const link = textTag(block, 'link')
    const description = textTag(block, 'description')
    if (!title || !link) continue
    let url: string
    try {
      const parsed = new URL(unwrapBingNewsLink(link))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      parsed.hash = ''
      url = parsed.toString()
    } catch {
      continue
    }
    if (seen.has(url) || /(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue
    seen.add(url)
    hits.push({
      title: stripHtml(title).slice(0, 180),
      url,
      snippet: stripHtml(description).slice(0, 360)
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** Bing News RSS wraps publisher links in an apiclick redirect. */
function unwrapBingNewsLink(link: string): string {
  try {
    const parsed = new URL(link)
    if (/(^|\.)bing\.com$/i.test(parsed.hostname) && /\/news\/apiclick\.aspx$/i.test(parsed.pathname)) {
      const target = parsed.searchParams.get('url')
      if (target && /^https?:\/\//i.test(target)) return target
    }
  } catch {
    // Fall through to the raw link; parseRss validates it again.
  }
  return link
}

/** Brave first, then RSS pages, then news snippets. */
function providerRank(hit: SearchHit): number {
  if (hit.provider === 'brave') return 0
  if (hit.provider === 'web') return 1
  return 2
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    if (seen.has(hit.url)) return false
    seen.add(hit.url)
    return true
  })
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function textTag(block: string, name: string): string {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block)
  if (!match) return ''
  return decodeEntities(unwrapCdata(match[1])).trim()
}

function unwrapCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, '$1').trim()
}

function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}
