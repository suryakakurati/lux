import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { TtlCache } from './cache.ts'

export interface PublicPage {
  title: string
  text: string
  url: string
  fetchedAt?: number
  cached?: boolean
}

const MAX_TEXT = 6_000
const MAX_REDIRECTS = 5
const pageCache = new TtlCache<PublicPage>(80)
const TTL_MS = 10 * 60_000

/**
 * Hosts that only exist on this machine or its local network. A model-supplied
 * URL must not be able to read Ollama, a dev server, an admin panel or a router
 * just because it is reachable from here.
 */
const LOCAL_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i

/** A name that only resolves on this machine or its local network. */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOST.test(host)
}

/** True for loopback, private, link-local, CGNAT and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (family === 6) {
    const value = ip.toLowerCase()
    if (value === '::' || value === '::1') return true
    if (value.startsWith('fe80') || value.startsWith('fc') || value.startsWith('fd')) return true
    // An IPv4 address mapped into IPv6 must be judged by its IPv4 value.
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7))
    return false
  }
  return false
}

/**
 * Synchronous check for the browser: true for anything that is not a public web
 * address. Names are judged by shape; `openWeb` still resolves a hostname before
 * loading, which covers a public-looking name that points at loopback.
 */
export function isBlockedTarget(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host || isLocalHost(host)) return true
  return isIP(host) !== 0 && isPrivateAddress(host)
}

/**
 * Only a public http(s) page may be read. IP literals and local names are
 * checked directly; a hostname is resolved and refused if *any* of its
 * addresses is private, which also blocks a DNS name pointing at loopback.
 */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  const url = raw instanceof URL ? raw : new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https pages can be read (got ${url.protocol})`)
  }
  if (url.username || url.password) {
    throw new Error('a page URL with embedded credentials is not fetched')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('that URL has no host')
  if (isLocalHost(host)) {
    throw new Error(`${host} is this machine or its local network, not a public page`)
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`${host} is a private address, not a public page`)
    }
    return url
  }
  try {
    const addresses = await lookup(host, { all: true })
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new Error(`${host} resolves to a private address, not a public page`)
    }
  } catch (error) {
    // A resolution failure is reported by fetch with a clearer message; a
    // private address is not, so that one is rethrown.
    if (error instanceof Error && error.message.includes('resolves to a private address')) throw error
  }
  return url
}

/**
 * Fetch a public page and return readable text.
 *
 * No cookies and no browser: this is the fast path for pages that need no
 * session. Authenticated pages must go through browser_open instead. Redirects
 * are followed by hand so every hop is checked against the same policy.
 */
export async function readPublicPage(
  url: string,
  fresh = false,
  signal?: AbortSignal
): Promise<PublicPage> {
  if (!fresh) {
    const cached = pageCache.get(url)
    if (cached) return { ...cached, cached: true }
  }

  const timeout = AbortSignal.timeout(12_000)
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout

  let target = await assertPublicUrl(url)
  let response: Response | null = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetch(target, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      },
      redirect: 'manual',
      signal: combined
    })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) break
    if (hop === MAX_REDIRECTS) throw new Error(`too many redirects for ${url}`)
    target = await assertPublicUrl(new URL(location, target).toString())
  }
  if (!response) throw new Error(`no response for ${url}`)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const type = response.headers.get('content-type') ?? ''
  if (!/html|text|xml/i.test(type)) throw new Error(`not a readable page (${type || 'unknown type'})`)

  const html = await response.text()
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim()
  const text = htmlToText(html)
  const page: PublicPage = {
    title,
    url: response.url || target.toString(),
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
