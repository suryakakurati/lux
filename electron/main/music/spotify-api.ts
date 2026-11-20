import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Settings } from '../../../shared/types'
import {
  parseTrackSearch,
  searchTerm,
  tokenUsable,
  type SpotifyTrack,
  type TokenState,
  type TrackQuery
} from '../../../shared/spotify'
import { logLine } from '../log'

/**
 * Spotify's Web API, kept as an optional second resolver.
 *
 * Development-mode apps now require the app owner to have Premium, and a free
 * account gets 403 "Active premium subscription required…" on every endpoint.
 * The rendered search page in `web-search.ts` is the route that always works;
 * this client is used when it is available, because it returns richer metadata.
 */

const TOKEN_URL = process.env.LUX_SPOTIFY_TOKEN_URL ?? 'https://accounts.spotify.com/api/token'
const API_BASE = process.env.LUX_SPOTIFY_API_BASE ?? 'https://api.spotify.com'
const DEFAULT_TTL_MS = 55 * 60 * 1000

export interface SpotifyAuth {
  clientId: string
  clientSecret: string
}

export type SearchFailure =
  | 'no-credentials'
  | 'auth-failed'
  | 'premium-required'
  | 'forbidden'
  | 'rate-limited'
  | 'network'
  | 'no-results'

export interface SearchResult {
  tracks: SpotifyTrack[]
  failure?: SearchFailure
  detail?: string
}

type TokenFile = Record<string, TokenState>

function tokenFile(): string {
  return join(app.getPath('userData'), 'cache', 'spotify-token.json')
}

function readTokens(): TokenFile {
  try {
    const parsed = JSON.parse(readFileSync(tokenFile(), 'utf8')) as TokenFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeTokens(tokens: TokenFile): void {
  try {
    const file = tokenFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(tokens))
  } catch {
    /* the token cache is an optimisation */
  }
}

/** Settings first, then the environment: both are the person's own machine. */
export function credentials(settings: Settings): SpotifyAuth | null {
  const clientId = (settings.spotifyClientId || process.env.SPOTIFY_CLIENT_ID || '').trim()
  const clientSecret = (settings.spotifyClientSecret || process.env.SPOTIFY_CLIENT_SECRET || '').trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

async function accessToken(
  auth: SpotifyAuth
): Promise<{ token?: string; failure?: SearchFailure; detail?: string }> {
  const cached = readTokens()[auth.clientId]
  if (tokenUsable(cached)) return { token: cached.accessToken }

  const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(8_000)
    })
  } catch (error) {
    return { failure: 'network', detail: error instanceof Error ? error.message : String(error) }
  }

  if (response.status === 400 || response.status === 401) {
    return { failure: 'auth-failed', detail: 'Spotify rejected the client id and secret (invalid_client).' }
  }
  if (!response.ok) {
    return { failure: 'network', detail: `token endpoint returned ${response.status}` }
  }

  const body = (await response.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number }
    | null
  const token = body?.access_token
  if (!token) return { failure: 'auth-failed', detail: 'token response had no access_token' }

  const ttl = (body?.expires_in ?? 3_600) * 1_000
  const tokens = readTokens()
  tokens[auth.clientId] = { accessToken: token, expiresAt: Date.now() + Math.min(ttl, DEFAULT_TTL_MS) }
  writeTokens(tokens)
  return { token }
}

export async function searchTracks(
  auth: SpotifyAuth | null,
  query: TrackQuery,
  limit = 6
): Promise<SearchResult> {
  if (!auth) return { tracks: [], failure: 'no-credentials' }

  const authResult = await accessToken(auth)
  if (!authResult.token) {
    return { tracks: [], failure: authResult.failure ?? 'auth-failed', detail: authResult.detail }
  }

  const url = `${API_BASE}/v1/search?type=track&limit=${Math.min(10, Math.max(1, limit))}&q=${encodeURIComponent(
    searchTerm(query)
  )}`

  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${authResult.token}` },
      signal: AbortSignal.timeout(8_000)
    })
  } catch (error) {
    return { tracks: [], failure: 'network', detail: error instanceof Error ? error.message : String(error) }
  }

  if (response.status === 401) {
    const tokens = readTokens()
    delete tokens[auth.clientId]
    writeTokens(tokens)
    return { tracks: [], failure: 'auth-failed', detail: 'search returned 401, token cleared' }
  }
  if (response.status === 429) {
    return { tracks: [], failure: 'rate-limited', detail: 'Spotify is rate limiting searches from this app.' }
  }
  if (response.status === 403) {
    const body = await response.text().catch(() => '')
    if (/premium/i.test(body)) {
      return {
        tracks: [],
        failure: 'premium-required',
        detail: body.trim().slice(0, 200) || 'Active premium subscription required for the app owner.'
      }
    }
    return { tracks: [], failure: 'forbidden', detail: body.trim().slice(0, 200) || 'Spotify refused the request.' }
  }
  if (!response.ok) {
    return { tracks: [], failure: 'network', detail: `search returned ${response.status}` }
  }

  const tracks = parseTrackSearch(await response.json().catch(() => null))
  logLine('spotify-api', `search "${searchTerm(query)}" -> ${tracks.length} tracks`)
  if (tracks.length === 0) return { tracks: [], failure: 'no-results' }
  return { tracks }
}
