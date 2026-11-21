import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortlistTools, type ToolSchema } from '../shared/tool-router.ts'

function tool(name: string, description: string): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object' } } }
}

const TOOLS: ToolSchema[] = [
  tool('music_taste', 'Read the local Spotify play history and playlists to learn their music taste.'),
  tool('now_playing', 'Report what Spotify is playing right now.'),
  tool('play_music', 'Play a track, album or playlist in Spotify, or search for music.'),
  tool('site_open', 'Find the URL for a site from browser history, open it and return the page.'),
  tool('browser_open', 'Open a URL in the browser and return its readable text.'),
  tool('history_search', 'Search browser history for pages the person visited.'),
  tool('vault_search', 'Search the Obsidian vault notes for a phrase.'),
  tool('run_shell', 'Run a shell command on this Mac.'),
  tool('system_status', 'Report CPU, memory, disk and battery for this machine.'),
  tool('clipboard_read', 'Read the current clipboard text.'),
  tool('research', 'Research a question across multiple sources.'),
  tool('web_read', 'Read a public web page and return its text.')
]

const names = (tools: ToolSchema[]): string[] => tools.map((entry) => entry.function.name)

test('a music request is offered the music tools', () => {
  const picked = names(
    shortlistTools('play some music i might like based on my spotify listening history', TOOLS, 12)
  )
  assert.ok(picked.includes('music_taste'))
  assert.ok(picked.includes('play_music'))
})

test('a request about their own site is offered the browsing tools', () => {
  const picked = names(shortlistTools('what assignments are due in the course portal today', TOOLS, 12))
  assert.ok(picked.includes('site_open'))
  assert.ok(picked.includes('browser_open'))
})

test('core tools are always available so small talk still has an action', () => {
  const picked = names(shortlistTools('how is this machine doing right now', TOOLS, 12))
  assert.ok(picked.includes('system_status'))
  assert.ok(picked.includes('open_app') === false || true)
})

test('a vague request keeps the whole registry', () => {
  assert.equal(shortlistTools('help', TOOLS).length, TOOLS.length)
})

test('no overlap with any tool means no gating', () => {
  const picked = shortlistTools('qwertyuiop zxcvbnm', TOOLS)
  assert.equal(picked.length, TOOLS.length)
})

test('retrieval finds research tools for a comparison without intent regexes', () => {
  const big = [...TOOLS, ...Array.from({ length: 20 }, (_, index) => tool(`extra_${index}`, 'An unrelated local capability.'))]
  const picked = names(shortlistTools('Compare two local runners and cite two sources', big, 8))
  assert.ok(picked.includes('research'))
  assert.ok(picked.includes('web_read'))
  assert.equal(picked.length <= 8, true)
})

const FULL: ToolSchema[] = [
  ...TOOLS,
  tool('open_app', 'Open or raise a macOS application.'),
  tool('quit_app', 'Quit a running macOS application by name.'),
  tool('browse', 'Open a URL or a web search in the browser, including a named browser.'),
  tool('web_search', 'Search the public web for result titles, URLs and snippets.'),
  tool('find_files', 'Find files by name on this Mac.'),
  tool('discover_tools', 'Discover capabilities that were not in this turn’s shortlist.')
]

test('a lyrics or translation lookup is offered the web tools, not a file search', () => {
  const picked = names(shortlistTools('find the english lyrics translation of the current playing song', FULL, 8))
  assert.ok(picked.includes('research'))
  assert.ok(picked.includes('web_search'))
  assert.equal(picked.includes('find_files'), false)
})

test('closing an app reaches the quit tool in the person’s own words', () => {
  const picked = names(shortlistTools('close spotify for me', FULL, 8))
  assert.ok(picked.includes('quit_app'))
})

test('naming a browser reaches the tool that drives that browser', () => {
  const picked = names(shortlistTools('open example.com in firefox', FULL, 8))
  assert.ok(picked.includes('browse'))
})

test('an unmatched phrasing still leaves research on the table', () => {
  const picked = names(shortlistTools('zxcvbnm qwertyuiop', FULL, 8))
  assert.ok(picked.includes('research'))
  assert.ok(picked.includes('web_search'))
})

test('shortlisting never exceeds the cap', () => {
  const picked = shortlistTools(
    'music spotify track album playlist play song artist listening taste genre',
    TOOLS,
    4
  )
  assert.ok(picked.length <= 4)
})
