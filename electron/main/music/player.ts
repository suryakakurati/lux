import { existsSync } from 'node:fs'
import { exec, osascript } from '../mac/exec'

/** Small wrappers around the Spotify desktop app's AppleScript surface. */

export interface SpotifyState {
  installed: boolean
  running: boolean
}

export async function spotifyState(): Promise<SpotifyState> {
  const listing = await exec('/usr/bin/lsappinfo', ['list'], { timeout: 3_000 })
  return {
    installed: existsSync('/Applications/Spotify.app'),
    running: /bundleID="com\.spotify\.client"/.test(listing.stdout)
  }
}

export async function apple(script: string, timeout = 4_000): Promise<string> {
  const result = await osascript(script, timeout)
  return result.code === 0 ? result.stdout.trim() : ''
}

export interface Playing {
  uri: string
  title: string
  artist: string
  album: string
  state: string
}

/**
 * Read the current track and player state.
 *
 * Four small `get` expressions rather than one script that concatenates them:
 * Spotify's scripting dictionary rejects a multi-property `return` with a
 * coercion in it, and a failed script is indistinguishable from an empty player.
 * These forms are each valid on every Spotify version.
 */
export async function nowPlaying(): Promise<Playing | null> {
  const state = await spotifyState()
  if (!state.running) return null
  const [uri, title, artist, album, player] = await Promise.all([
    apple('tell application "Spotify" to get spotify url of current track'),
    apple('tell application "Spotify" to get name of current track'),
    apple('tell application "Spotify" to get artist of current track'),
    apple('tell application "Spotify" to get album of current track'),
    apple('tell application "Spotify" to get player state as string')
  ])
  if (!uri && !title) return null
  return { uri, title, artist, album, state: player }
}

/** Open Spotify's own search UI — the honest fallback when a name cannot resolve. */
export async function openSearch(query: string): Promise<void> {
  await exec('/usr/bin/open', [`spotify:search:${encodeURIComponent(query)}`], { timeout: 6_000 })
  await apple('tell application "Spotify" to activate')
}
