import type { Settings } from '../../../shared/types'
import {
  parseTrackSpec,
  pickBest,
  pickBestTrack,
  scoreName,
  type SpotifyTrack,
  type TrackQuery
} from '../../../shared/spotify'
import { labelFor, readCache, remember, resolveHistoryNames } from './history'
import { credentials, searchTracks, type SearchFailure } from './spotify-api'
import { webSearchTracks } from './web-search'

/**
 * One name → one playable URI.
 *
 * The order is chosen for what actually works on a free Spotify account:
 *
 *   1. the local cache — instant and offline;
 *   2. the play history, named from public embed pages;
 *   3. Spotify's rendered search page — no account, no key, no Premium;
 *   4. the Web API, when credentials are configured and entitled;
 *   5. an honest failure naming the step that blocked it.
 *
 * Nothing here guesses. If none of those can identify the track, the caller is
 * told exactly why, and the failure is a value rather than an exception.
 */

/** A cached name has to be a good match before it becomes playback. */
const CACHE_MATCH_MIN = 0.62
/** Web search is already ranked by Spotify; only reject obvious noise. */
const WEB_MATCH_MIN = 0.35
/** The API needs a normal match too. */
const API_MATCH_MIN = 0.45

export type ResolveFailure = SearchFailure | 'not-found'

export interface Resolved {
  uri?: string
  label?: string
  reason?: ResolveFailure
  detail?: string
}

export interface CatalogResult {
  tracks: SpotifyTrack[]
  source: 'web' | 'api'
  failure?: SearchFailure | 'not-found'
  detail?: string
}

export function playableUri(raw: string): string | null {
  const value = raw.trim()
  const direct = /^spotify:(track|album|playlist|artist):[A-Za-z0-9]+$/.exec(value)
  if (direct) return value
  // A pasted open.spotify.com link is the same thing.
  const link = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/.exec(value)
  if (link) return `spotify:${link[1]}:${link[2]}`
  return null
}

/**
 * A name from the local cache.
 *
 * Playlists and albums count: "play my playlist stuff" is answered from the same
 * cache that `music_taste` fills, without touching the network.
 */
function findCached(query: TrackQuery): { uri: string; label: string } | null {
  const cache = readCache()
  const entries = Object.entries(cache).map(([uri, meta]) => ({
    uri,
    title: meta.title,
    artist: meta.artist ?? ''
  }))
  if (entries.length === 0) return null
  const best = pickBest(
    query,
    entries,
    (wanted, candidate) => scoreName(wanted, { title: candidate.title, artist: candidate.artist }),
    CACHE_MATCH_MIN
  )
  if (!best) return null
  return { uri: best.uri, label: best.artist ? `${best.title} — ${best.artist}` : best.title }
}

/** The best web result for a name, remembered so the next request is offline. */
async function fromWeb(query: TrackQuery, minimum = WEB_MATCH_MIN): Promise<Resolved | null> {
  const web = await webSearchTracks(query, 10)
  if (web.tracks.length === 0) return null
  const best = pickBestTrack(query, web.tracks, minimum)
  if (!best) return null
  const artist = best.artists.join(', ')
  remember(best.uri, { title: best.name, artist, album: best.album })
  return { uri: best.uri, label: artist ? `${best.name} — ${artist}` : best.name }
}

async function fromApi(query: TrackQuery, settings: Settings): Promise<Resolved | null> {
  const auth = credentials(settings)
  if (!auth) return null
  const result = await searchTracks(auth, query, 8)
  if (result.failure || result.tracks.length === 0) return null
  const best = pickBestTrack(query, result.tracks, API_MATCH_MIN)
  if (!best) return null
  const artist = best.artists.join(', ')
  remember(best.uri, { title: best.name, artist, album: best.album })
  return { uri: best.uri, label: artist ? `${best.name} — ${artist}` : best.name }
}

export async function resolveTrack(spec: string, settings: Settings): Promise<Resolved> {
  const direct = playableUri(spec)
  if (direct) return { uri: direct, label: labelFor(direct, direct) }

  const query = parseTrackSpec(spec)
  if (!query) return { reason: 'not-found' }

  const cached = findCached(query)
  if (cached) return cached

  // The history is the only offline name index; resolving a slice of it is what
  // makes already-played songs work by name with no network.
  await resolveHistoryNames()
  const fromHistory = findCached(query)
  if (fromHistory) return fromHistory

  const web = await fromWeb(query)
  if (web) return web

  const api = await fromApi(query, settings)
  if (api) return api

  // Distinguish "nothing matched" from "the lookup could not run", so the reply
  // tells the person what to do rather than blaming the song.
  const auth = credentials(settings)
  if (auth) {
    const probe = await searchTracks(auth, query, 1)
    if (probe.failure === 'premium-required') {
      return { reason: 'premium-required', detail: probe.detail }
    }
    if (probe.failure === 'network' || probe.failure === 'rate-limited') {
      return { reason: probe.failure, detail: probe.detail }
    }
    if (probe.failure === 'auth-failed') {
      return { reason: 'auth-failed', detail: probe.detail }
    }
  }
  return { reason: 'not-found' }
}

/**
 * All matches for a query, web first.
 *
 * `spotify_search` is for seeing the versions that exist, so it returns the whole
 * ranked list rather than a single pick.
 */
export async function searchCatalog(
  query: TrackQuery,
  settings: Settings,
  limit = 8
): Promise<CatalogResult> {
  const web = await webSearchTracks(query, limit)
  if (web.tracks.length > 0) return { tracks: web.tracks, source: 'web' }

  const auth = credentials(settings)
  if (auth) {
    const api = await searchTracks(auth, query, limit)
    if (api.tracks.length > 0) return { tracks: api.tracks, source: 'api' }
    if (api.failure) return { tracks: [], source: 'api', failure: api.failure, detail: api.detail }
  }

  return {
    tracks: [],
    source: 'web',
    failure: web.reason === 'timeout' || web.reason === 'unavailable' ? 'network' : 'not-found',
    detail: web.reason
  }
}
