import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSearchRows, pickBestTrack } from '../shared/spotify.ts'

test('parses rendered search rows into track URIs', () => {
  const tracks = parseSearchRows([
    { href: '/track/3USxtqRwSYz57Ewm6wWRMp', title: 'Heat Waves', artist: 'Glass Animals' },
    { href: '/track/3Che0Dm9dlytqujcprVAwE', title: 'Heat Waves', artist: 'Glass Animals' }
  ])
  assert.equal(tracks.length, 2)
  assert.equal(tracks[0].uri, 'spotify:track:3USxtqRwSYz57Ewm6wWRMp')
  assert.equal(tracks[0].name, 'Heat Waves')
  assert.deepEqual(tracks[0].artists, ['Glass Animals'])
})

test('drops malformed ids, empty titles and duplicates', () => {
  const tracks = parseSearchRows([
    { href: '/track/short', title: 'Nope', artist: '' },
    { href: '/track/3USxtqRwSYz57Ewm6wWRMp', title: '', artist: '' },
    { href: '/track/3USxtqRwSYz57Ewm6wWRMp', title: 'Heat Waves', artist: 'Glass Animals' },
    { href: '/track/3USxtqRwSYz57Ewm6wWRMp', title: 'Heat Waves (again)', artist: 'Glass Animals' }
  ])
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].name, 'Heat Waves')
})

test('keeps a query with an artist on the matching version', () => {
  const tracks = parseSearchRows([
    { href: '/track/1K2RnVhm3eauKnA8PAcPu1', title: 'Heat Waves - Slowed', artist: 'Glass Animals' },
    { href: '/track/3USxtqRwSYz57Ewm6wWRMp', title: 'Heat Waves', artist: 'Glass Animals' }
  ])
  const best = pickBestTrack({ title: 'Heat Waves', artist: 'Glass Animals' }, tracks, 0.35)
  assert.equal(best?.name, 'Heat Waves')
})
