import { musicQueue, playUri } from '../music-queue'
import { apple, nowPlaying, openSearch, spotifyState } from '../music/player'
import { labelFor, readPlayHistory, resolveAll } from '../music/history'
import { playableUri, resolveTrack, searchCatalog, type ResolveFailure } from '../music/resolve'
import {
  formatDuration,
  parseTrackSpec,
  splitSpecs,
  type SpotifyTrack
} from '../../../shared/spotify'
import { logLine } from '../log'
import type { ToolDef } from './types'

/**
 * Spotify tools.
 *
 * Reading (history, current track) and playing are deliberately separate: a
 * request to see what has been playing must never start playback as a side
 * effect. The resolution policy lives in `../music/resolve.ts`; this file is the
 * tool surface and the wording of failures.
 */

function failureText(reason: ResolveFailure, spec: string, detail?: string): string {
  if (reason === 'premium-required') {
    return `Spotify's API refused the lookup because the app owner's account does not have Premium. That path is optional — Lux normally uses Spotify's public search page — but this lookup still came back empty. Check that Spotify's search finds "${spec}" in the app.`
  }
  if (reason === 'no-credentials') {
    return `Spotify's search page did not return a match for "${spec}". Try the title with the artist, e.g. "Heat Waves — Glass Animals".`
  }
  if (reason === 'auth-failed') {
    return `Spotify's API rejected the saved Client ID and Secret (${detail ?? 'invalid client'}). This does not block the public search page, so the name could still not be found there either.`
  }
  if (reason === 'forbidden') {
    return `Spotify refused the API lookup (${detail ?? '403'}). Public search was tried first and returned nothing for "${spec}".`
  }
  if (reason === 'rate-limited') {
    return `Spotify is rate limiting lookups right now, so "${spec}" could not be identified. It usually clears within a minute.`
  }
  if (reason === 'network') {
    return `Spotify's search page could not be reached (${detail ?? 'network error'}), so "${spec}" was not resolved. Spotify's own search is open for it in the meantime.`
  }
  return `Spotify has no track matching "${spec}" closely enough to play it. Try the title with the artist, e.g. "Heat Waves — Glass Animals".`
}

function trackLine(track: SpotifyTrack, index: number): string {
  const meta = [track.artists.join(', '), track.album, formatDuration(track.durationMs)]
    .filter(Boolean)
    .join(' · ')
  return `${index + 1}. ${track.name}${meta ? ` — ${meta}` : ''} — ${track.uri}`
}

/** Bounded concurrency keeps several name lookups from queueing behind one page. */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export const musicTools: ToolDef[] = [
  {
    name: 'music_taste',
    description:
      'Read this Mac\u2019s music taste: Spotify\u2019s local play history, the playlists in rotation and the current track, resolved to artist and track names. Use before recommending music, or whenever asked what they listen to.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        tracks: { type: 'integer', description: 'How many top tracks to resolve (default 10, max 18).' },
        playlists: { type: 'integer', description: 'How many playlists to resolve (default 5, max 8).' }
      }
    },
    async run(args) {
      const trackLimit = Math.min(18, Math.max(3, Number(args.tracks ?? 10)))
      const playlistLimit = Math.min(8, Math.max(0, Number(args.playlists ?? 5)))

      const history = readPlayHistory()
      logLine('music', `history entries=${history.length}`)
      const trackUris = history.filter((entry) => entry.kind === 'track').slice(0, trackLimit)
      const playlistUris = history.filter((entry) => entry.kind === 'playlist').slice(0, playlistLimit)

      const current = await nowPlaying()
      const toResolve = [...trackUris, ...playlistUris].map((entry) => entry.uri)
      if (current?.uri && !toResolve.includes(current.uri)) toResolve.push(current.uri)
      const metas = await resolveAll(toResolve)
      logLine('music', `resolved ${metas.size}/${toResolve.length} names`)

      if (trackUris.length === 0 && playlistUris.length === 0 && !current) {
        return {
          content:
            'No local Spotify history and nothing playing. Spotify may never have been used on this Mac, or the app stores its history elsewhere. Ask what they have been listening to, or use play_music to search.',
          summary: 'no listening history'
        }
      }

      const lines: string[] = []
      if (current && !current.uri.startsWith('spotify:ad:')) {
        lines.push(`Now: ${current.title} — ${current.artist}${current.state ? ` (${current.state})` : ''}`)
      } else if (current) {
        lines.push('Now: an advertisement is playing (free account); no track is loaded.')
      }

      const artists = new Map<string, number>()
      if (trackUris.length > 0) {
        lines.push('', 'Most-played tracks on this Mac (local play history):')
        for (const entry of trackUris) {
          const meta = metas.get(entry.uri)
          if (!meta) continue
          lines.push(`- ${meta.title} — ${meta.artist}${meta.album ? ` · ${meta.album}` : ''} (${entry.count} plays)`)
          if (meta.artist) artists.set(meta.artist, (artists.get(meta.artist) ?? 0) + entry.count)
        }
      }

      if (playlistUris.length > 0) {
        lines.push('', 'Playlists in rotation:')
        for (const entry of playlistUris) {
          const meta = metas.get(entry.uri)
          if (meta) lines.push(`- ${meta.title} (${entry.count} sessions)`)
        }
      }

      if (artists.size > 0) {
        const top = [...artists.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        lines.push('', `Artists that recur: ${top.map(([name]) => name).join(', ')}`)
      }

      lines.push('', 'This is data from this Mac, not a statement of identity: read it as evidence of what is currently in rotation.')

      const first = trackUris[0] ? metas.get(trackUris[0].uri) : undefined
      return {
        content: lines.join('\n'),
        summary: first ? `taste · ${first.artist || first.title}` : 'taste read',
        openChat: true
      }
    }
  },
  {
    name: 'now_playing',
    description: 'Report what Spotify is playing right now, with artist and album, or that it is paused.',
    risk: 'safe',
    parallelSafe: true,
    params: { type: 'object', properties: {} },
    async run() {
      const state = await spotifyState()
      if (!state.installed) return { content: 'Spotify is not installed on this Mac.', summary: 'spotify missing' }
      if (!state.running) return { content: 'Spotify is not running.', summary: 'spotify closed' }

      const playing = await nowPlaying()
      if (playing?.uri.startsWith('spotify:ad:')) {
        return {
          content: 'Spotify is playing an advertisement (free account); no track is loaded.',
          summary: 'spotify ad'
        }
      }
      if (!playing || !playing.title) {
        return { content: 'Spotify is open with no track loaded.', summary: 'spotify idle' }
      }
      return {
        content: `${playing.title} — ${playing.artist} (${playing.album})${playing.state ? ` — ${playing.state}` : ''}`,
        summary: `${playing.title.slice(0, 60)}`,
        openChat: false
      }
    }
  },
  {
    name: 'spotify_search',
    description:
      'Look up tracks on Spotify by name and get their spotify:track URIs and artists. Use to check which version exists, or to pick between matches before play_music.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Song and artist, e.g. "Heat Waves Glass Animals".' },
        limit: { type: 'integer', description: 'How many matches to return (default 6, max 10).' }
      },
      required: ['query']
    },
    async run(args, context) {
      const raw = String(args.query ?? '').trim()
      if (!raw) return { content: 'Give a song or artist to look up.', summary: 'nothing to search' }

      const limit = Math.min(10, Math.max(1, Number(args.limit ?? 6)))
      const query = parseTrackSpec(raw) ?? { title: raw }
      const result = await searchCatalog(query, context.settings, limit)

      if (result.tracks.length === 0) {
        return {
          content: failureText(result.failure ?? 'not-found', raw, result.detail),
          summary: `spotify search: ${result.failure ?? 'no results'}`,
          openChat: true
        }
      }

      const lines = result.tracks.map((track, index) => trackLine(track, index))
      return {
        content: `Spotify matches for "${raw}" (${result.source === 'web' ? 'public search' : 'Web API'}):\n${lines.join('\n')}`,
        summary: `${result.tracks.length} spotify matches`,
        openChat: true
      }
    }
  },
  {
    name: 'play_music',
    // Resolving several names plus waiting out a free-account ad can take a while.
    timeoutMs: 120_000,
    description:
      'Play music in Spotify and start it immediately. Give tracks one or more names ("Heat Waves — Glass Animals") or spotify URIs: the first plays now and the rest are queued in order, so a list plays through. Give uri for an exact album or playlist. A bare search is never the answer.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        tracks: {
          type: 'string',
          description:
            'One or more tracks to play in order: names as "Title — Artist", separated by newlines or commas, or spotify:track URIs.'
        },
        uri: { type: 'string', description: 'A spotify: URI or open.spotify.com link: track, album or playlist.' },
        query: { type: 'string', description: 'A single song or artist to play.' },
        resume: { type: 'boolean', description: 'Resume whatever was paused (only when that is what they asked for).' }
      }
    },
    async run(args, context) {
      const direct = playableUri(String(args.uri ?? ''))

      if (direct) {
        const started = await playUri(direct)
        const playing = await apple('tell application "Spotify" to get spotify url of current track')
        if (!started && !playing) {
          return { content: `Spotify did not start ${direct}.`, summary: 'playback failed' }
        }
        if (playing && playing !== direct) {
          return {
            content: `Asked Spotify to play ${direct}, but it reports ${playing} instead. Do not claim it is playing the requested track.`,
            summary: 'playback mismatch'
          }
        }
        musicQueue.stop('single uri')
        return { content: `Playing ${labelFor(direct, direct)}.`, summary: 'playing uri' }
      }

      const raw = [String(args.tracks ?? ''), String(args.query ?? '')]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n')
      const specs = splitSpecs(raw)

      if (specs.length === 0) {
        if (args.resume === true) {
          const resumed = await apple('tell application "Spotify" to play')
          return resumed === ''
            ? { content: 'Resumed Spotify playback.', summary: 'resume spotify' }
            : { content: 'Spotify is not running.', summary: 'spotify closed' }
        }
        return {
          content:
            'Nothing to play: give tracks (names or URIs) or resume. Do not resume playback to find out what they listen to.',
          summary: 'nothing to play'
        }
      }

      const settled = await mapLimit(specs, 2, async (spec) => ({
        spec,
        hit: await resolveTrack(spec, context.settings)
      }))

      const resolved: { spec: string; uri: string; label: string }[] = []
      const failed: { spec: string; reason: ResolveFailure; detail?: string }[] = []
      for (const { spec, hit } of settled) {
        if (hit.uri) resolved.push({ spec, uri: hit.uri, label: hit.label ?? spec })
        else failed.push({ spec, reason: hit.reason ?? 'not-found', detail: hit.detail })
      }

      if (resolved.length === 0) {
        // Nothing to play: open the search so the screen is not empty, and say
        // plainly which name failed and what would fix it.
        await openSearch(specs[0] ?? '')
        const first = failed[0]
        return {
          content: failureText(first?.reason ?? 'not-found', first?.spec ?? specs[0] ?? '', first?.detail),
          summary: `could not play ${(specs[0] ?? '').slice(0, 40)}`,
          openChat: true
        }
      }

      const head = resolved[0]
      const started = await playUri(head.uri)
      // The list handed to the watcher starts with what is playing now: it watches
      // that track and takes over from it when it ends. Starting from the second
      // track makes the first one look like a stranger and burns the queue.
      if (resolved.length > 1) musicQueue.start(resolved.map((item) => item.uri))
      else musicQueue.stop('single track')

      const lines: string[] = [`Playing: ${head.label}`]
      if (resolved.length > 1) {
        lines.push(`Queued ${resolved.length - 1} more, in order:`)
        resolved.slice(1).forEach((item, index) => lines.push(`${index + 2}. ${item.label}`))
      }
      for (const miss of failed) {
        lines.push('', failureText(miss.reason, miss.spec, miss.detail))
      }
      if (!started) lines.push('', 'Spotify did not acknowledge the play command; check that it is running.')

      return {
        content: lines.join('\n'),
        summary:
          resolved.length > 1
            ? `playing ${resolved.length} tracks`
            : `playing ${head.label.slice(0, 60)}`,
        openChat: resolved.length > 1 || failed.length > 0
      }
    }
  },
  {
    name: 'spotify_control',
    description: 'Control Spotify playback: pause, next track, previous track, or resume.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'pause', 'next', 'previous'] }
      },
      required: ['action']
    },
    async run(args) {
      const action = String(args.action ?? 'pause')
      const map: Record<string, string> = {
        play: 'play',
        pause: 'pause',
        next: 'next track',
        previous: 'previous track'
      }
      const state = await spotifyState()
      if (!state.running) return { content: 'Spotify is not running.', summary: 'spotify closed' }
      await apple(`tell application "Spotify" to ${map[action] ?? 'pause'}`)
      if (action !== 'play' && action !== 'pause') musicQueue.stop('manual skip')
      return { content: `Spotify: ${action}.`, summary: `spotify ${action}` }
    }
  }
]
