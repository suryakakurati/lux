import { TtlCache } from './cache.ts'

export interface PublicPage {
  title: string
  text: string
  url: string
  fetchedAt?: number
  cached?: boolean
}

const MAX_TEXT = 6_000
const pageCache = new TtlCache<PublicPage>(80)
const TTL_MS = 10 * 60_000

/**
 * Fetch a public page and return readable text.
 *
 * No cookies and no browser: this is the fast path for pages that need no
 * session. Authenticated pages must go through browser_open instead.
 */
export async function readPublicPage(url: string, fresh = false): Promise<PublicPage> {
  if (!fresh) {
    const cached = pageCache.get(url)
    if (cached) return { ...cached, cached: true }
  }
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const type = response.headers.get('content-type') ?? ''
  if (!/html|text|xml/i.test(type)) throw new Error(`not a readable page (${type || 'unknown type'})`)

  const html = await response.text()
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim()
  const text = htmlToText(html)
  const page: PublicPage = {
    title,
    url: response.url || url,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    fetchedAt: Date.now(),
    cached: false
  }
  pageCache.set(url, page, TTL_MS)
  pageCache.set(page.url, page, TTL_MS)
  return page
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const blocks = stripped
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(blocks)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}
