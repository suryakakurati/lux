import { decodeEntities } from './read.ts'
import { TtlCache } from './cache.ts'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  /** Web results are directly readable; news results may only be snippets. */
  provider?: 'web' | 'news'
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  fetchedAt: number
  cached: boolean
}

const cache = new TtlCache<{ hits: SearchHit[]; at: number }>(64)
const TTL_MS = 8 * 60_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Lux/0.1'
const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'can', 'could', 'would', 'should', 'will', 'with',
  'that', 'this', 'these', 'those', 'from', 'have', 'has', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'how', 'why', 'does', 'did', 'about', 'into', 'over', 'under',
  'please', 'tell', 'give', 'find', 'want', 'need', 'some', 'any', 'all', 'in', 'on', 'at',
  'of', 'to', 'is', 'are', 'be', 'by', 'or', 'as', 'an', 'it'
])

/**
 * Search without a browser session.
 *
 * Two providers run together: Bing's RSS endpoint gives direct, readable pages,
 * while Google News gives relevant current headlines. Bing on its own can drift
 * toward "local news" for a phrase like "local AI models", so results are ranked
 * against the actual question terms and unreadable news stubs are marked rather
 * than passed off as pages. Both are keyless public feeds.
 */
export async function searchWeb(query: string, limit = 8): Promise<SearchResult> {
  const clean = query.replace(/\s+/g, ' ').trim()
  if (clean.length < 2) return { query: clean, hits: [], fetchedAt: Date.now(), cached: false }

  const key = `${clean.toLowerCase()}::${limit}`
  const cached = cache.get(key)
  if (cached) {
    return { query: clean, hits: cached.hits, fetchedAt: cached.at, cached: true }
  }

  const [bing, news] = await Promise.allSettled([
    fetchBing(clean, Math.min(20, Math.max(limit, 8))),
    fetchBingNews(clean, Math.min(limit, 8))
  ])
  let hits: SearchHit[] = [
    ...(bing.status === 'fulfilled' ? bing.value : []),
    ...(news.status === 'fulfilled' ? news.value : [])
  ]

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

  const ranked = rankHits(dedupe(hits), clean).slice(0, limit)
  const at = Date.now()
  cache.set(key, { hits: ranked, at }, TTL_MS)
  return { query: clean, hits: ranked, fetchedAt: at, cached: false }
}

/** Exported for tests: a stable relevance ordering with direct pages first. */
export function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return dedupe(hits)
  const contentTerms = new Set(
    terms.filter((term) => !/^(latest|new|news|recent|developments?|updates?|releases?|happening|today)$/i.test(term))
  )
  const requiresContent = contentTerms.size > 0
  const wantsNews = /\b(latest|news|recent|developments?|updates?|releases?|happening|today)\b/i.test(query)
  return dedupe(hits)
    .map((hit) => {
      const title = hit.title.toLowerCase()
      const snippet = hit.snippet.toLowerCase()
      const host = safeHost(hit.url)
      let score = hit.provider === 'web' ? 0.5 : wantsNews ? 2 : 0
      let contentMatches = 0
      for (const term of terms) {
        if (title.includes(term)) {
          score += 3
          if (contentTerms.has(term)) contentMatches += 1
        }
        if (snippet.includes(term)) score += 1
        if (host.includes(term)) {
          score += 1
          if (contentTerms.has(term)) contentMatches += 1
        }
      }
      // A bare news homepage is not evidence about the question.
      if (contentMatches === 0 && (requiresContent || /^\/?$/.test(safePath(hit.url)))) score = 0
      return { hit, score, contentMatches }
    })
    .filter((item) => item.score > 0 && (!requiresContent || item.contentMatches > 0))
    .sort((a, b) => b.score - a.score || (a.hit.provider === 'web' ? -1 : 1))
    .map((item) => item.hit)
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
