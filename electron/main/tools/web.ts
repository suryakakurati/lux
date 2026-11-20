import { exec, truncate } from '../mac/exec'
import type { ToolDef } from './types'

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
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL; https:// is added when missing.' }
      },
      required: ['url']
    },
    async run(args) {
      const raw = String(args.url ?? '').trim()
      const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
      const result = await exec('/usr/bin/open', [url], { timeout: 6_000 })
      if (result.code !== 0) {
        return { content: `Could not open ${url}: ${truncate(result.stderr, 160)}`, summary: 'open failed' }
      }
      return { content: `Opened ${url}.`, summary: `open ${new URL(url).hostname}` }
    }
  },
  {
    name: 'search_web',
    description:
      'Open a web search in the browser. Engines: google, duckduckgo, youtube, github, wikipedia, maps.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        engine: {
          type: 'string',
          description: 'Search engine to use (default google).',
          enum: ['google', 'duckduckgo', 'youtube', 'github', 'wikipedia', 'maps']
        }
      },
      required: ['query']
    },
    async run(args) {
      const query = String(args.query ?? '').trim()
      const engine = String(args.engine ?? 'google').toLowerCase()
      const build = ENGINES[engine] ?? ENGINES.google
      const result = await exec('/usr/bin/open', [build(query)], { timeout: 6_000 })
      if (result.code !== 0) {
        return { content: `Could not open the browser: ${truncate(result.stderr, 160)}`, summary: 'search failed' }
      }
      return { content: `Searched ${engine} for "${query}".`, summary: `${engine}: ${query}` }
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
