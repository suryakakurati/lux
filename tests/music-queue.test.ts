import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQueue, currentUri, nextAction, remaining, START_GRACE_MS } from '../shared/music-queue.ts'

/** Five real recommendations, queued the way "play all of them" queues them. */
const ITEMS = [
  'spotify:track:aaaa',
  'spotify:track:bbbb',
  'spotify:track:cccc',
  'spotify:track:dddd',
  'spotify:track:eeee'
]

const playing = (uri: string, positionSec = 30, durationSec = 240) => ({
  uri,
  playing: true,
  positionSec,
  durationSec
})

test('the queue drops blanks and duplicates', () => {
  const queue = createQueue(['spotify:track:aaaa', '', 'spotify:track:aaaa', 'spotify:track:bbbb'])
  assert.deepEqual(queue?.items, ['spotify:track:aaaa', 'spotify:track:bbbb'])
  assert.equal(createQueue([]), null)
})

test('the expected track is the one being watched', () => {
  const queue = createQueue(ITEMS)!
  assert.equal(currentUri(queue), 'spotify:track:aaaa')
  assert.equal(remaining(queue).length, 4)
})

test('a play that has not landed yet is not chased', () => {
  const queue = createQueue(ITEMS)!
  // The previous song is still on screen a second after the play command.
  const decision = nextAction(queue, playing('spotify:track:zzzz'), 1_000)
  assert.equal(decision.action, 'none')
  assert.equal(decision.queue.index, 0)
})

test('when the track ends, the next one starts', () => {
  const queue = createQueue(ITEMS)!
  const ended = nextAction(
    queue,
    { uri: 'spotify:track:aaaa', playing: false, positionSec: 240, durationSec: 240 },
    30_000
  )
  assert.equal(ended.action, 'play')
  assert.equal(ended.uri, 'spotify:track:bbbb')
  assert.equal(ended.queue.index, 1)
})

test('Spotify autoplaying something else hands the queue back', () => {
  const queue = createQueue(ITEMS)!
  const strayed = nextAction(queue, playing('spotify:track:radio-pick'), START_GRACE_MS + 500)
  assert.equal(strayed.action, 'play')
  assert.equal(strayed.uri, 'spotify:track:bbbb')
})

test('a paused track is left alone', () => {
  const queue = createQueue(ITEMS)!
  const paused = nextAction(
    queue,
    { uri: 'spotify:track:aaaa', playing: false, positionSec: 61, durationSec: 240 },
    40_000
  )
  assert.equal(paused.action, 'none')
})

test('skipping ahead is followed, not fought', () => {
  const queue = createQueue(ITEMS)!
  const skipped = nextAction(queue, playing('spotify:track:cccc'), 40_000)
  assert.equal(skipped.action, 'none')
  assert.equal(skipped.queue.index, 2)
  assert.equal(currentUri(skipped.queue), 'spotify:track:cccc')
})

test('skipping back is not treated as progress', () => {
  const queue = createQueue(ITEMS)!
  const back = nextAction({ ...queue, index: 3 }, playing('spotify:track:aaaa'), 40_000)
  // 'aaaa' is behind the cursor: hold rather than replay the list from the top.
  assert.equal(back.action, 'none')
  assert.equal(back.queue.index, 3)
})

test('the end of the list ends the queue', () => {
  const queue = createQueue(ITEMS)!
  const last = nextAction(
    { ...queue, index: 4 },
    { uri: 'spotify:track:eeee', playing: false, positionSec: 200, durationSec: 200 },
    40_000
  )
  assert.equal(last.action, 'done')
})

test('a track that never starts does not stall the list forever', () => {
  const queue = createQueue(ITEMS)!
  const stuck = nextAction(
    queue,
    { uri: 'spotify:track:aaaa', playing: false, positionSec: 0, durationSec: 0 },
    START_GRACE_MS + 1_000
  )
  assert.equal(stuck.action, 'play')
  assert.equal(stuck.uri, 'spotify:track:bbbb')
})

test('an empty player does not end a fresh queue', () => {
  const queue = createQueue(ITEMS)!
  const empty = nextAction(queue, { uri: '', playing: false, positionSec: 0, durationSec: 0 }, 500)
  assert.equal(empty.action, 'none')
})

test('an advertisement is waited out, never skipped over', () => {
  const queue = createQueue(ITEMS)!
  const ad = nextAction(
    queue,
    { uri: 'spotify:ad:1a069cd235fe42469025773319eae8e4', playing: true, positionSec: 8, durationSec: 30 },
    START_GRACE_MS + 30_000
  )
  // A free account plays ads between tracks. The queued track is still wanted.
  assert.equal(ad.action, 'none')
  assert.equal(ad.queue.index, 0)
})

test('an advertisement on the last track does not finish the queue', () => {
  const queue = createQueue(ITEMS)!
  const ad = nextAction(
    { ...queue, index: 4 },
    { uri: 'spotify:ad:abc', playing: true, positionSec: 3, durationSec: 30 },
    60_000
  )
  assert.equal(ad.action, 'none')
})
