import { exec, osascript, quoteForAppleScript } from './mac/exec'
import { logLine } from './log'
import { apple, spotifyState } from './music/player'
import {
  createQueue,
  nextAction,
  type PlayQueue,
  type PlayerSnapshot
} from '../../shared/music-queue'

/**
 * The runtime half of the queue: poll the player, and start the next track when
 * the current one is done. Spotify has no queue command through AppleScript, so
 * this is what "play all of them" is made of.
 */

const POLL_MS = 2_500

/**
 * Start a specific track for real, replacing whatever was queued.
 *
 * AppleScript's `play track` is the primitive that switches an already-playing
 * player; opening a `spotify:` URL only works from idle. The catch is that
 * `play track` returns success before the app is ready, so Spotify is launched
 * and allowed to answer first, then the URI is verified — a silent failure is
 * reported rather than mistaken for playback.
 */
export async function playUri(uri: string): Promise<boolean> {
  let state = await spotifyState()
  if (!state.running) {
    await exec('/usr/bin/open', ['-a', 'Spotify'], { timeout: 8_000 })
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(250)
      state = await spotifyState()
      if (state.running) break
    }
  }

  // Wait for the scripting interface, not just the process.
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const ready = await apple('tell application "Spotify" to get player state as string')
    if (ready) break
    await sleep(250)
  }

  // A free account's advertisement swallows a play command: Spotify reports
  // success and keeps playing the ad. Wait it out instead of losing the track.
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const current = await apple('tell application "Spotify" to get spotify url of current track')
    if (!current.startsWith('spotify:ad:')) break
    await sleep(1_000)
  }

  const started = await osascript(
    `tell application "Spotify" to play track "${quoteForAppleScript(uri)}"`,
    6_000
  )

  if (started.code !== 0) {
    // Scripting can be blocked by macOS automation permissions; the URL handler
    // still works when the player is idle.
    await exec('/usr/bin/open', [uri], { timeout: 8_000 })
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await apple('tell application "Spotify" to get spotify url of current track')
    if (current === uri) return true
    // Another ad began: the request was accepted, it just cannot be reflected
    // until the ad ends. The queue watcher waits ads out too.
    if (current.startsWith('spotify:ad:')) return true
    await sleep(300)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function playerSnapshot(): Promise<PlayerSnapshot | null> {
  const state = await spotifyState()
  if (!state.running) return null
  const [uri, playerState, position, duration] = await Promise.all([
    apple('tell application "Spotify" to get spotify url of current track'),
    apple('tell application "Spotify" to get player state as string'),
    apple('tell application "Spotify" to get player position'),
    apple('tell application "Spotify" to get duration of current track')
  ])
  return {
    uri: uri.trim(),
    playing: playerState.trim().toLowerCase() === 'playing',
    positionSec: Number(position) || 0,
    // AppleScript reports track duration in milliseconds.
    durationSec: Number(duration) > 1000 ? Number(duration) / 1_000 : Number(duration) || 0
  }
}

class MusicQueue {
  private queue: PlayQueue | null = null
  private timer: NodeJS.Timeout | null = null
  private startedAt = 0

  /** Replace any running queue with this list, starting from `items[0]`. */
  start(uris: string[]): PlayQueue | null {
    const queue = createQueue(uris)
    if (!queue) {
      this.stop('empty')
      return null
    }
    this.stop('replaced')
    this.queue = queue
    this.startedAt = Date.now()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    // Watching playback must never be the reason Electron stays alive.
    this.timer.unref?.()
    logLine('queue', `started items=${queue.items.length}`)
    return queue
  }

  stop(reason = 'done'): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.queue) logLine('queue', `stopped reason=${reason}`)
    this.queue = null
  }

  active(): PlayQueue | null {
    return this.queue
  }

  private async tick(): Promise<void> {
    const queue = this.queue
    if (!queue) {
      this.stop('empty')
      return
    }
    const snapshot = await playerSnapshot()
    if (!snapshot) return

    const decision = nextAction(queue, snapshot, Date.now() - this.startedAt)
    this.queue = decision.queue

    if (decision.action === 'play' && decision.uri) {
      const ok = await playUri(decision.uri)
      this.startedAt = Date.now()
      logLine('queue', `advance index=${decision.queue.index} url=${decision.uri} ok=${ok}`)
      return
    }
    if (decision.action === 'done') {
      this.stop('finished')
    }
  }
}

export const musicQueue = new MusicQueue()
