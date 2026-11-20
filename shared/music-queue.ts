/**
 * Playing a list, one track at a time.
 *
 * "Play all of them" is not a search: Spotify's AppleScript surface can start one
 * URI and nothing else. There is no queue command, no playlist creation and no
 * API token involved, so the queue is kept here and advanced by watching the
 * player. Keeping the decision pure means the awkward cases — a track that ends,
 * the person skipping ahead, Spotify autoplaying its own choice, a pause
 * mid-track — can be tested without Spotify running.
 */

export interface PlayQueue {
  items: string[]
  /** Index of the track that is supposed to be playing now. */
  index: number
}

export interface PlayerSnapshot {
  /** `spotify:track:…` of the current track, or '' when nothing is loaded. */
  uri: string
  playing: boolean
  positionSec?: number
  durationSec?: number
}

export type QueueAction = 'none' | 'play' | 'done'

export interface QueueDecision {
  action: QueueAction
  /** Track to start when `action` is 'play'. */
  uri?: string
  queue: PlayQueue
}

/**
 * How long a freshly started track may take to become the current track before
 * the watcher is allowed to conclude that it never started.
 */
export const START_GRACE_MS = 6_000
/** Within this much of the end, a stopped player means the track finished. */
const END_TOLERANCE_SEC = 5

export function createQueue(uris: string[]): PlayQueue | null {
  const items: string[] = []
  for (const uri of uris) {
    const value = uri.trim()
    if (value && !items.includes(value)) items.push(value)
  }
  return items.length > 0 ? { items, index: 0 } : null
}

export function currentUri(queue: PlayQueue): string | null {
  return queue.items[queue.index] ?? null
}

export function remaining(queue: PlayQueue): string[] {
  return queue.items.slice(queue.index + 1)
}

export function isFinished(queue: PlayQueue, snapshot: PlayerSnapshot): boolean {
  return queue.items[queue.index] === snapshot.uri && !snapshot.playing
}

/**
 * A free account inserts advertisements between tracks. They are playback, but
 * they are not evidence that the queue should move: a play request issued while
 * one is running is dropped, and the track it named is still wanted.
 */
export function isAdvertisement(snapshot: PlayerSnapshot): boolean {
  return snapshot.uri.startsWith('spotify:ad:')
}

/**
 * What the watcher should do now.
 *
 * The expected track is the only thing this trusts. Everything else is evidence
 * that it has moved on:
 *
 *   - the player is on a later item of the queue → the person skipped forward,
 *     so follow them instead of fighting them;
 *   - the player is on something else entirely while playing → the track ended
 *     and Spotify autoplayed a radio pick, so take the queue back;
 *   - the player is on the expected track but stopped near its end → it finished,
 *     so start the next one;
 *   - the player is stopped mid-track → the person paused; leave it alone.
 */
export function nextAction(queue: PlayQueue, snapshot: PlayerSnapshot, waitedMs: number): QueueDecision {
  const expected = currentUri(queue)
  if (!expected) return { action: 'done', queue }

  const observed = snapshot.uri.trim()

  // Wait the advertisement out. Advancing here would skip a real track for
  // every ad, which on a free account is most of them.
  if (isAdvertisement(snapshot)) return { action: 'none', queue }

  if (observed && observed !== expected) {
    const at = queue.items.indexOf(observed)
    if (at > queue.index) {
      // Spotify reached the next queued track on its own, or they skipped to it.
      return { action: 'none', queue: { ...queue, index: at } }
    }
    // They picked something earlier in the list: follow the person, not the plan.
    if (at >= 0) return { action: 'none', queue }
    // A play request takes a moment to land. Do not chase it.
    if (waitedMs < START_GRACE_MS) return { action: 'none', queue }
    if (snapshot.playing) return advance(queue)
    return { action: 'none', queue }
  }

  if (snapshot.playing) return { action: 'none', queue }

  const position = snapshot.positionSec ?? 0
  const duration = snapshot.durationSec ?? 0
  if (duration > 0 && position >= duration - END_TOLERANCE_SEC) return advance(queue)
  // Stopped at the very start, or nothing loaded at all: the play did not take.
  if (duration <= 0 || position <= 1) {
    if (waitedMs >= START_GRACE_MS) return advance(queue)
  }
  return { action: 'none', queue }
}

function advance(queue: PlayQueue): QueueDecision {
  const next = queue.index + 1
  if (next >= queue.items.length) {
    return { action: 'done', queue: { ...queue, index: queue.items.length } }
  }
  const uri = queue.items[next]
  return { action: 'play', uri, queue: { ...queue, index: next } }
}
