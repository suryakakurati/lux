import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusQuery, parseRss, rankHits } from '../electron/main/web/search.ts'

test('RSS items become clean, deduplicated search hits', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Local AI agents &amp; tools]]></title><link>https://example.com/a#section</link><description>Useful &lt;b&gt;roundup&lt;/b&gt;</description></item>
    <item><title>Local AI agents &amp; tools</title><link>https://example.com/a</link><description>duplicate</description></item>
    <item><title>Unsafe</title><link>javascript:alert(1)</link><description>nope</description></item>
    <item><title>Bing</title><link>https://www.bing.com/search?q=x</link><description>nope</description></item>
  </channel></rss>`
  const hits = parseRss(xml, 8)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].title, 'Local AI agents & tools')
  assert.equal(hits[0].url, 'https://example.com/a')
  assert.equal(hits[0].snippet, 'Useful roundup')
})

test('RSS parsing honours the result limit and ignores malformed items', () => {
  const xml = `<rss><channel>
    <item><title>One</title><link>https://example.com/1</link></item>
    <item><title>Two</title><link>not a url</link></item>
    <item><title>Three</title><link>https://example.com/3</link></item>
  </channel></rss>`
  assert.deepEqual(
    parseRss(xml, 1).map((hit) => hit.title),
    ['One']
  )
})

test('relevance ranking drops unrelated homepages and keeps the question terms', () => {
  const ranked = rankHits(
    [
      { title: 'Fox News — breaking headlines', url: 'https://foxnews.com/', snippet: 'News.', provider: 'web' },
      {
        title: 'Best local AI models for a laptop',
        url: 'https://example.com/local-ai-models',
        snippet: 'A benchmark of local models.',
        provider: 'web'
      },
      {
        title: 'New local AI model released',
        url: 'https://news.google.com/rss/articles/x',
        snippet: 'Released this week.',
        provider: 'news'
      }
    ],
    'latest local AI models'
  )
  assert.deepEqual(
    ranked.map((hit) => hit.url),
    ['https://example.com/local-ai-models', 'https://news.google.com/rss/articles/x']
  )
})

test('a drifted natural-language query gets a focused topic phrase', () => {
  assert.equal(focusQuery('latest developments in local AI models'), '"local ai model"')
  assert.equal(focusQuery('open source'), '"open source"')
})
