/**
 * Reading the end of a reply.
 *
 * A round with no tool call can mean three different things, and the loop used
 * to treat all of them as "done":
 *
 *   done     — the answer is in hand.
 *   question — a genuine fork that only the person can settle.
 *   stalled  — the reply either announces work it did not do ("Let me check…")
 *              or hands the next step back to the person ("Would you like me
 *              to open Spotify?").
 *
 * Only the third is a failure. These predicates are deliberately deterministic:
 * a classifier call would cost another full model round trip on a 9B model,
 * which is the difference between "thinking for two minutes" and "answering".
 */

/** \u201cI'll open it\u201d / \u201cLet me check\u201d — an announcement anywhere in the reply. */
const PROMISE =
  /(?:^|[.!?]\s+)(?:okay[,.]?\s*|sure[,.]?\s*|alright[,.]?\s*)?(?:i'?ll|i will|let me(?!\s+know)|i'?m going to|i am going to|next,? i'?ll|now i'?ll|first,? i'?ll)\b/i

/**
 * \u201cWould you like me to…\u201d / \u201cShall I…\u201d / \u201cI can open that for you\u201d.
 * These read as helpful and are the single most common way a turn dies with the
 * job undone.
 */
const OFFER =
  /\b(?:would you like me to|would you like me to go|want me to|shall i|should i|do you want me to|let me know if|if you(?:'d| would) like|happy to)\b|(?:^|[.!?]\s+)i can (?:also )?(?:open|check|read|look|search|find|play|pull|set|add|put|make|get)\b/i

/**
 * A capability claim that is now untrue — Lux has the tools.
 *
 * The URI lines are here because of one real reply: the assistant decided a
 * track could not be played without its "exact Spotify URI", and that its tools
 * could not "extract those URIs from search results". It could not, then. It can
 * now, so the excuse has to send the turn back to work rather than end it.
 */
const FALSE_LIMIT =
  /\b(?:i (?:can'?t|cannot|don'?t|do not) (?:have )?(?:access|see|read|check|browse)|no way (?:to|for me to)|not able to (?:access|see|read|check)|technical limitation|requires? (?:the )?exact (?:track )?(?:uris?|ids?)|(?:can'?t|cannot|unable to) (?:extract|resolve|look up) (?:the )?(?:exact )?(?:uris?|track ids?)|would need (?:their|the) exact)\b/i

const QUESTION_END = /\?[\s"'`)\]]*$/

/** Last one or two sentences: where a reply makes its exit. */
function tail(text: string, sentences = 2): string {
  const parts = text.trim().split(/(?<=[.!?])\s+/)
  return parts.slice(-sentences).join(' ')
}

/**
 * A promise counts anywhere in the reply.
 *
 * "Let me check what's been playing" followed by two clarifying questions is
 * exactly the stall that started all this, and the promise sat three sentences
 * before the end, so reading only the last sentences missed it.
 */
export function promisesAction(text: string): boolean {
  return PROMISE.test(text)
}

export function offersToAct(text: string): boolean {
  return OFFER.test(tail(text, 2)) || (endsWithQuestion(text) && OFFER.test(text))
}

export function claimsFalseLimit(text: string): boolean {
  return FALSE_LIMIT.test(tail(text, 2))
}

export function endsWithQuestion(text: string): boolean {
  return QUESTION_END.test(text.trim())
}

export type StallKind = 'promise' | 'offer' | 'false-limit'

export interface StopContext {
  /** At least one tool has run this turn. */
  usedTools: boolean
  /** The request is one Lux can act on with its tools. */
  actionable: boolean
}

/**
 * Why this reply is not an answer, or null when it is one.
 *
 * A question is only suspicious when there is something to act on: asking what
 * kind of music someone likes is legitimate, asking whether they would like you
 * to look at their Spotify when they just told you to is not.
 */
/**
 * Below this length a reply has not delivered anything to react to, so an offer
 * at the end is a substitute for the work rather than a follow-up to it.
 */
const DELIVERED_LENGTH = 240

export function stallReason(text: string, context: StopContext): StallKind | null {
  const reply = text.trim()
  if (!reply) return context.usedTools ? 'promise' : null
  const canAct = context.usedTools || context.actionable
  if (!canAct) return null
  if (promisesAction(reply)) return 'promise'
  // A closing "want me to play one?" after a real set of recommendations is an
  // answer with an offer attached, not a turn that died. Only a short reply that
  // offers instead of delivering is a stall.
  if (offersToAct(reply) && reply.length < DELIVERED_LENGTH) return 'offer'
  if (claimsFalseLimit(reply)) return 'false-limit'
  return null
}

/**
 * The directive that replaces a stalled draft for the next round.
 *
 * It deliberately contains none of the phrases it forbids. A small model echoes
 * the last text it was shown, so quoting the failure invites it back in.
 */
export function nudgeFor(kind: StallKind, objective: string): string {
  const target = objective.trim() || 'the request'
  if (kind === 'false-limit') {
    return `You have the tools for this: ${target}. Do not describe a limitation. Call the tool that reads it now, then answer from what it returned.`
  }
  if (kind === 'offer') {
    return `They already asked you to do this: ${target}. Take the step instead of asking about it — call the tool now, then answer with the result. Handing the next step back as a question is the failure.`
  }
  return `Do it now, in this turn: ${target}. Call the tool instead of describing it, then answer with what it actually returned. Announce nothing; act, then report.`
}
