import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatDuration,
  parseTrackSearch,
  parseTrackSpec,
  pickBestTrack,
  scoreName,
  scoreTrack,
  searchTerm,
  splitSpecs,
  tokenUsable,
  type SpotifyTrack
} from '../shared/spotify.ts'

/**
 * These cover the failure that started this: five real recommendations, a request
 * to play all of them, and an assistant that answered with "I need their exact
 * Spotify URIs".
 */

const TRACKS: SpotifyTrack[] = [
  { uri: 'spotify:track:3VZQshi4COChhXaz7cLP02', name: 'Heat Waves (Sped Up)', artists: ['Glass Animals'], durationMs: 218_000 },
  { uri: 'spotify:track:02MWAaffLxlfxAUY7c5dvx', name: 'Heat Waves', artists: ['Glass Animals'], durationMs: 238_000 },
  { uri: 'spotify:track:6iVh7Lz0rTDNn9oTi3srqL', name: 'Heat Waves (Live)', artists: ['Glass Animals'], durationMs: 251_000 }
]

test('the studio version beats sped-up and live variants', () => {
  const best = pickBestTrack({ title: 'Heat Waves', artist: 'Glass Animals' }, TRACKS)
  assert.equal(best?.uri, 'spotify:track:02MWAaffLxlfxAUY7c5dvx')
})

test('a wrong artist lowers the score but a right one raises it', () => {
  const right = scoreName({ title: 'Bones', artist: 'Imagine Dragons' }, { title: 'Bones', artist: 'Imagine Dragons' })
  const wrong = scoreName({ title: 'Bones', artist: 'Imagine Dragons' }, { title: 'Bones', artist: 'Someone Else' })
  assert.ok(right > wrong)
  assert.ok(right > 0.9)
})

test('an unrelated name is rejected instead of guessed', () => {
  assert.equal(pickBestTrack({ title: 'Bohemian Rhapsody' }, TRACKS), null)
})

test('an exact title without an artist still wins', () => {
  const best = pickBestTrack({ title: 'Heat Waves' }, TRACKS)
  assert.equal(best?.uri, 'spotify:track:02MWAaffLxlfxAUY7c5dvx')
})

test('titles match across punctuation and case', () => {
  const track: SpotifyTrack = {
    uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    name: "Don't Start Now",
    artists: ['Dua Lipa'],
    durationMs: 183_000
  }
  assert.ok(scoreTrack({ title: 'Dont Start Now', artist: 'Dua Lipa' }, track) > 0.9)
})

test('a written name splits into title and artist', () => {
  assert.deepEqual(parseTrackSpec('Heat Waves — Glass Animals'), {
    title: 'Heat Waves',
    artist: 'Glass Animals'
  })
  assert.deepEqual(parseTrackSpec('Sweater Weather - The Neighbourhood'), {
    title: 'Sweater Weather',
    artist: 'The Neighbourhood'
  })
  assert.deepEqual(parseTrackSpec('Bones by Imagine Dragons'), {
    title: 'Bones',
    artist: 'Imagine Dragons'
  })
  assert.deepEqual(parseTrackSpec('3. "Levitating" — Dua Lipa'), {
    title: 'Levitating',
    artist: 'Dua Lipa'
  })
  assert.deepEqual(parseTrackSpec('Sunflower'), { title: 'Sunflower' })
})

test('a list becomes one track per line, without duplicates', () => {
  const specs = splitSpecs(
    'Sunflower — Post Malone & Swae Lee\nBones — Imagine Dragons\nheat waves — glass animals\nHeat Waves — Glass Animals\n\n'
  )
  assert.equal(specs.length, 3)
  assert.equal(specs[2], 'heat waves — glass animals')
})

test('a comma inside one track name does not split it', () => {
  assert.deepEqual(splitSpecs('Sunflower — Post Malone, Swae Lee'), ['Sunflower — Post Malone, Swae Lee'])
})

test('a comma-separated list of tracks does split', () => {
  const specs = splitSpecs('Heat Waves — Glass Animals, Levitating — Dua Lipa')
  assert.deepEqual(specs, ['Heat Waves — Glass Animals', 'Levitating — Dua Lipa'])
})

test('the search term keeps the artist', () => {
  assert.equal(searchTerm({ title: 'Bones', artist: 'Imagine Dragons' }), 'Bones Imagine Dragons')
  assert.equal(searchTerm({ title: 'Bones' }), 'Bones')
})

test('search results are parsed defensively', () => {
  const payload = {
    tracks: {
      items: [
        { uri: 'spotify:track:02MWAaffLxlfxAUY7c5dvx', name: 'Heat Waves', artists: [{ name: 'Glass Animals' }], album: { name: 'Dreamland' }, duration_ms: 238_000 },
        { uri: 'not-a-uri', name: 'Junk', artists: [] },
        { name: 'No uri at all', artists: [] },
        null
      ]
    }
  }
  const tracks = parseTrackSearch(payload)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].album, 'Dreamland')
})

test('a malformed payload yields no tracks rather than throwing', () => {
  assert.deepEqual(parseTrackSearch(null), [])
  assert.deepEqual(parseTrackSearch({ tracks: { items: 'nope' } }), [])
})

test('a cached token is not used at the edge of its life', () => {
  const now = 1_000_000
  assert.equal(tokenUsable({ accessToken: 'x', expiresAt: now + 600_000 }, now), true)
  assert.equal(tokenUsable({ accessToken: 'x', expiresAt: now + 30_000 }, now), false)
  assert.equal(tokenUsable(null, now), false)
})

test('durations read the way a person writes them', () => {
  assert.equal(formatDuration(238_000), '3:58')
  assert.equal(formatDuration(0), '')
})
