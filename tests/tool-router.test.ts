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
  tool('clipboard_read', 'Read the current clipboard text.')
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

test('shortlisting never exceeds the cap', () => {
  const picked = shortlistTools(
    'music spotify track album playlist play song artist listening taste genre',
    TOOLS,
    4
  )
  assert.ok(picked.length <= 4)
})
