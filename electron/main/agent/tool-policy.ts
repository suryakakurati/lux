/**
 * Whether a repeated tool call is allowed to run again.
 *
 * Small local models retry the same call when a page did not change, which burns
 * the turn. But an exact repeat after a *failed* call is sometimes right: a
 * network lookup or a page load may simply have timed out. The distinction is
 * kept here so the loop stays readable and the rule can be tested.
 */

export interface Attempt {
  ok: boolean
  content: string
}

export type RepeatDecision = 'run' | 'retry' | 'block'

/** Failures that are worth exactly one more try. */
const TRANSIENT =
  /timed out|timeout|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|could not be reached|temporarily|rate limit/i

export function repeatDecision(previous: Attempt[]): RepeatDecision {
  if (previous.length === 0) return 'run'
  const last = previous[previous.length - 1]
  // A successful identical call is a loop: the answer is already in the context.
  if (last.ok) return 'block'
  // One retry for a transient failure, never a third attempt.
  if (previous.length < 2 && TRANSIENT.test(last.content)) return 'retry'
  return 'block'
}

export function repeatMessage(name: string, previous: Attempt[]): string {
  const last = previous[previous.length - 1]
  const why = last?.ok
    ? 'It already succeeded'
    : 'It already failed the same way'
  return `${why}: you called ${name} with these exact arguments. Do not repeat it. Read the last result, use a different argument, or answer with what you have.`
}
