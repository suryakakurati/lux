/**
 * Pick the first sentence worth speaking while the model is still writing.
 *
 * This is deliberately conservative: only a complete sentence, never a
 * one-word acknowledgement or a preamble such as "Sure." The full answer still
 * arrives on screen; this is for the voice loop's time-to-first-spoken-word.
 */
const FILLER = /^(?:sure|okay|ok|of course|absolutely|here(?:'s| is)|let me|i'll|i will|one moment)\b/i

export function firstSpokenSentence(markdown: string): string | null {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return null

  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? []
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (sentence.length < 8 || FILLER.test(sentence)) continue
    if (sentence.endsWith(':')) continue
    return sentence.length <= 240 ? sentence : `${sentence.slice(0, 240).replace(/\s+\S*$/, '')}…`
  }
  return null
}
