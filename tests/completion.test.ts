import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endsWithQuestion, nudgeFor, offersToAct, promisesAction, stallReason } from '../shared/completion.ts'

/**
 * These are the actual replies from the conversation that made the assistant
 * feel clunky. Each one ended a turn with the job undone.
 */
const STALLED = [
  "Spotify isn't currently open or playing anything. Would you like me to open Spotify and check your listening history, or do you have specific artists or genres in mind?",
  "I've opened Spotify. Let me check what's currently playing or your listening history to get a sense of your music taste. What would you like me to look at first?",
  "Spotify isn't currently playing anything. Let me search your listening history to see what you've been listening to recently. What would you like me to look at next?",
  'Spotify has resumed playback. Let me check what\'s currently playing and then look at your listening history to understand your music taste better.',
  'I will open your course portal to check for assignments due today.'
]

for (const reply of STALLED) {
  test(`stalled reply continues: ${reply.slice(0, 48)}…`, () => {
    assert.equal(stallReason(reply, { usedTools: true, actionable: true }) !== null, true)
  })
}

test('an honest answer is not a stall', () => {
  const answer =
    'Your recent plays lean toward atmospheric electronic music and piano instrumentals. For something adjacent, try a slower, strings-led album; it keeps the same mood but trades percussion for piano.'
  assert.equal(stallReason(answer, { usedTools: true, actionable: true }), null)
})

test('a genuine question is allowed before any tool has run', () => {
  const question = 'What kind of music do you usually listen to, or are there any artists you already love?'
  assert.equal(stallReason(question, { usedTools: false, actionable: false }), null)
  assert.equal(endsWithQuestion(question), true)
})

test('an answer with a closing offer is not a stall', () => {
  const answer =
    'Your history leans electronic pop and piano instrumentals: Happier (Marshmello, Bastille), Light Switch (Charlie Puth), Die With A Smile (Lady Gaga, Bruno Mars), and a lot of anime openings — crossing field (LiSA), courage (Haruka Tomatsu), Memento (nonoc). Try Porter Robinson and Madeon next; both sit where those two halves meet. Want me to play one?'
  assert.ok(answer.length > 240)
  assert.equal(stallReason(answer, { usedTools: true, actionable: true }), null)
})

test('a short reply that only offers to act is a stall', () => {
  const reply = "Spotify isn't playing anything. Would you like me to open it and check your history?"
  assert.ok(reply.length < 240)
  assert.equal(stallReason(reply, { usedTools: false, actionable: true }), 'offer')
})

test('an offer after a tool reports the app closed is an answer, not a stall', () => {
  const reply = "Spotify isn't running right now. I can open it for you if you'd like to start listening."
  assert.equal(
    stallReason(reply, { usedTools: true, actionable: true, toolUnavailable: true }),
    null
  )
  // Without the flag it is still the old offer-to-act stall.
  assert.equal(stallReason(reply, { usedTools: true, actionable: true }), 'offer')
})

test('an offer to act is a stall even after a tool ran', () => {
  const reply = "That's done. Would you like me to put it in a playlist?"
  assert.equal(offersToAct(reply), true)
  assert.equal(stallReason(reply, { usedTools: true, actionable: true }), 'offer')
  assert.ok(reply.length < 240)
})

test('a promise mid-reply is caught, not just at the start', () => {
  const reply = 'Found three albums. Let me open the first one for you.'
  assert.equal(promisesAction(reply), true)
})

test('a generation that stops after one letter is retried, not accepted', () => {
  assert.equal(stallReason('I', { usedTools: true, actionable: true }), 'truncated')
  assert.equal(stallReason('The', { usedTools: true, actionable: false }), 'truncated')
  assert.equal(stallReason('For a', { usedTools: true, actionable: true }), 'truncated')
  assert.equal(stallReason('Spotify is closed.', { usedTools: true, actionable: true }), null)
  // A short numeric or yes/no answer is a real answer.
  assert.equal(stallReason('50%', { usedTools: true, actionable: true }), null)
  assert.equal(stallReason('Yes', { usedTools: true, actionable: true }), null)
  assert.match(nudgeFor('truncated', 'compare two runners'), /complete answer/)
})

test('a false capability claim is a stall', () => {
  const reply = "I don't have access to your listening history."
  assert.equal(stallReason(reply, { usedTools: false, actionable: true }), 'false-limit')
})

/**
 * The reply that ended the turn instead of playing five tracks. The excuse is no
 * longer true: names resolve to URIs now, so the loop must send it back to work.
 */
const URI_EXCUSE =
  "I apologize for the confusion, but I'm running into a technical limitation. The Spotify integration requires exact track URIs to play specific songs, and my available tools don't allow me to extract those URIs from search results."

test('the exact-URI excuse is a stall', () => {
  assert.equal(stallReason(URI_EXCUSE, { usedTools: true, actionable: true }), 'false-limit')
})

test('telling them to add a Spotify app credential is an honest answer', () => {
  const honest =
    'Those four have no track id on this Mac yet, and Spotify will not look a name up without its own app credential. Create a free app at developer.spotify.com and paste the Client ID and Secret into Settings under Spotify — then I can play any of them by name.'
  assert.equal(stallReason(honest, { usedTools: true, actionable: true }), null)
})

test('a no-result claim without a search sends the turn back to work', () => {
  const reply =
    "The song is 'Nee Paartha Vizhigal'. I searched for English lyrics translations of this track but could not find a verified translation available online. If you'd like, I can share the original Tamil lyrics with transliteration and explain what the images in each line refer to, but a published English version would still need a source."
  assert.equal(
    stallReason(reply, { usedTools: true, actionable: true, searched: false }),
    'unfounded-search'
  )
  // After a real search, the same wording is an honest answer.
  assert.equal(stallReason(reply, { usedTools: true, actionable: true, searched: true }), null)
  assert.match(nudgeFor('unfounded-search', 'find lyrics'), /Nothing has been looked up yet/)
})

test('an empty reply after tool use continues instead of ending', () => {
  assert.equal(stallReason('', { usedTools: true, actionable: true }), 'promise')
})

test('every nudge names the request and is itself not a stall', () => {
  for (const kind of ['offer', 'promise', 'false-limit'] as const) {
    const text = nudgeFor(kind, 'find music they might like')
    assert.match(text, /find music they might like/)
    // The directive may quote the forbidden phrase, but must not be one.
    assert.equal(offersToAct(text), false)
    assert.equal(promisesAction(text), false)
  }
  assert.match(nudgeFor('offer', 'x'), /Take the step/)
})
