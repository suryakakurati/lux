import { exec, truncate } from '../mac/exec'
import type { ToolDef } from './types'

/** People name their browser; `/usr/bin/open` needs the app name it ships as. */
const BROWSERS: Record<string, string> = {
  default: '',
  system: '',
  firefox: 'Firefox',
  safari: 'Safari',
  chrome: 'Google Chrome',
  brave: 'Brave Browser',
  arc: 'Arc',
  edge: 'Microsoft Edge'
}

const ENGINES: Record<string, (query: string) => string> = {
  google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  duckduckgo: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
  youtube: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  github: (query) => `https://github.com/search?q=${encodeURIComponent(query)}`,
  wikipedia: (query) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
  maps: (query) => `https://maps.apple.com/?q=${encodeURIComponent(query)}`
}

export const webTools: ToolDef[] = [
  {
    name: 'browse',
    description:
      'Open a URL in the person\u2019s real browser, or run a web search there and show it. Use this for "open …", "take me to …" and "search … for me", including a named browser (Firefox, Safari, Chrome). Use web_search instead when the answer needs result text in the conversation.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'open or search.', enum: ['open', 'search'] },
        url: { type: 'string', description: 'Full URL for action=open; https:// is added when missing.' },
        query: { type: 'string', description: 'Search terms for action=search.' },
        engine: {
          type: 'string',
          description: 'Search engine for action=search (default google).',
          enum: ['google', 'duckduckgo', 'youtube', 'github', 'wikipedia', 'maps']
        },
        app: {
          type: 'string',
          description:
            'Which browser to use. Omit or "default" for their default browser; pass firefox, safari, chrome, brave, arc or edge when they name one.',
          enum: ['default', 'firefox', 'safari', 'chrome', 'brave', 'arc', 'edge']
        }
      },
      required: ['action']
    },
    async run(args, context) {
      const app = String(args.app ?? 'default').toLowerCase()
      if (args.action === 'search') {
        const query = String(args.query ?? '').trim()
        if (!query) return { content: 'Give me a search query.', summary: 'empty search' }
        const engine = String(args.engine ?? 'google').toLowerCase()
        const build = ENGINES[engine] ?? ENGINES.google
        const opened = await openInBrowser(build(query), app, context.signal)
        if (!opened.ok) {
          return { content: `Could not open the browser: ${opened.detail}`, summary: 'search failed' }
        }
        return {
          content: `Searched ${engine} for "${query}" in ${opened.browser}.`,
          summary: `${opened.browser.toLowerCase()}: ${query}`
        }
      }

      const raw = String(args.url ?? '').trim()
      if (!raw) return { content: 'Give me a URL to open.', summary: 'missing url' }
      const url = openableUrl(raw)
      if (!url) {
        return {
          content: 'I can open http, https and mailto links. That address uses another scheme, so I did not hand it to the browser.',
          summary: 'blocked url scheme',
          fail: 'invalid_args'
        }
      }
      const opened = await openInBrowser(url, app, context.signal)
      if (!opened.ok) {
        return { content: `Could not open ${url}: ${opened.detail}`, summary: 'open failed' }
      }
      return {
        content: `Opened ${url} in ${opened.browser}.`,
        summary: `open ${hostOf(url)}`
      }
    }
  },
  {
    name: 'news_digest',
    description:
      'Fetch current headlines from Google News for a topic (or top stories). Returns headline text only.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to search headlines for. Omit for top stories.' },
        limit: { type: 'integer', description: 'How many headlines (default 8, max 15).', minimum: 1, maximum: 15 }
      }
    },
    async run(args) {
      const topic = String(args.topic ?? '').trim()
      const limit = Math.min(15, Math.max(1, Number(args.limit ?? 8)))
      const url = topic
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`
        : 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en'
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Lux/0.1 (local assistant)' },
          signal: AbortSignal.timeout(9_000)
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const xml = await response.text()
        const items = xml.split('<item>').slice(1, limit + 1)
        const headlines = items
          .map((block) => {
            const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? ''
            return decodeEntities(stripCdata(title)).trim()
          })
          .filter(Boolean)
        if (headlines.length === 0) {
          return { content: 'No headlines came back for that topic.', summary: 'no headlines' }
        }
        return {
          content: headlines.map((line, index) => `${index + 1}. ${line}`).join('\n'),
          summary: `${headlines.length} headlines`,
          openChat: true
        }
      } catch (error) {
        return {
          content: `Could not reach Google News: ${error instanceof Error ? error.message : String(error)}`,
          summary: 'news unreachable'
        }
      }
    }
  }
]

/**
 * Open a URL in a named browser, falling back to the default one. Opening the
 * wrong app is better than doing nothing visible, but the reply says which one
 * actually opened.
 */
/** A URL the person's browser may be handed: web pages and mail, nothing local. */
export function openableUrl(raw: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null
    return url.toString()
  } catch {
    return null
  }
}

async function openInBrowser(
  url: string,
  app: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string; browser: string }> {
  const named = BROWSERS[app] ?? ''
  if (!named) {
    const result = await exec('/usr/bin/open', [url], { timeout: 6_000, signal })
    if (result.code !== 0) return { ok: false, detail: truncate(result.stderr, 160), browser: 'default browser' }
    return { ok: true, detail: '', browser: 'the default browser' }
  }

  const direct = await exec('/usr/bin/open', ['-a', named, url], { timeout: 8_000, signal })
  if (direct.code === 0) return { ok: true, detail: '', browser: named }

  const fallback = await exec('/usr/bin/open', [url], { timeout: 6_000, signal })
  if (fallback.code === 0) {
    return { ok: true, detail: '', browser: `the default browser (${named} could not be opened)` }
  }
  return {
    ok: false,
    detail: truncate(direct.stderr || fallback.stderr, 160),
    browser: named
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}
