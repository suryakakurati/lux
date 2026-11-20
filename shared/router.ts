/**
 * Outcome routing: decide where the result of a turn belongs.
 *
 * The product rule is simple — short confirmations stay in the voice HUD, while
 * anything with substance (an explanation, a list, code, or a requested view)
 * opens the chat window. Pure function so it is easy to test and tune.
 */
export interface RouteInput {
  text: string
  hadTools: boolean
  threshold: number
  userAskedToShow: boolean
}

export type Route = 'chat' | 'hud'

const SHOW_INTENT = /\b(show|explain|summari[sz]e|write|draft|list|compare|research|why|how does|tell me about|give me)\b/i

export function shouldOpenChat(input: RouteInput): boolean {
  const text = input.text.trim()
  if (!text) return input.hadTools
  if (input.userAskedToShow) return true
  if (SHOW_INTENT.test(text) && text.length > 120) return true

  const structural =
    text.includes('\n') ||
    text.includes('```') ||
    /(^|\n)\s*([-*]|\d+\.)\s/.test(text) ||
    text.length > input.threshold

  return structural
}
