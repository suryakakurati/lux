/**
 * Pick the first sentence worth speaking while the model is still writing.
 *
 * This is deliberately conservative: only a complete sentence, never a
 * one-word acknowledgement or a preamble such as "Sure." The full answer still
 * arrives on screen; this is for the voice loop's time-to-first-spoken-word.
 */
const FILLER = /^(?:sure|okay|ok|of course|absolutely|here(?:'s| is)|let me|i'll|i will|one moment)\b/i

export interface VoiceOption {
  name: string
  language: string
  quality: 'premium' | 'enhanced' | 'standard'
}

/**
 * Markdown read aloud is noise: `say` spells out URLs and asterisks, and emoji
 * vanish. The preview sentence and the spoken text both start here.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
    .replace(/[→»]/g, ' to ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstSpokenSentence(markdown: string): string | null {
  const plain = plainText(markdown)
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

/**
 * Plain text for speech, paced and capped. The cap keeps a long answer from
 * holding the microphone for a minute.
 */
export function speechText(markdown: string, limit = 480): string {
  const plain = plainText(markdown)
  if (!plain) return ''
  const clipped =
    plain.length <= limit ? plain : `${plain.slice(0, limit).replace(/[,;:\s]+\S*$/, '')}…`
  return paceSentences(clipped)
}

/**
 * A short pause at each sentence boundary is the difference between an
 * announcer and a list of words. `[[slnc ms]]` is a macOS `say` command.
 */
export function paceSentences(text: string): string {
  return text.replace(/([.!?…])\s+(?=\S)/g, '$1 [[slnc 150]] ')
}

/** `Ava (Premium)` and `Ava` are the same voice at different quality tiers. */
export function voiceBaseName(name: string): string {
  return name.replace(/\s+\((Premium|Enhanced)\)$/i, '').trim()
}

/** A downloaded Premium or Enhanced voice, as opposed to a compact one. */
export function isNaturalVoice(name: string): boolean {
  return /\((Premium|Enhanced)\)$/i.test(name)
}

/**
 * Anything Premium beats anything Enhanced, which beats the legacy compact
 * voices. Within a tier, this order is roughly warm and neutral first.
 */
const VOICE_ORDER = [
  'Ava',
  'Zoe',
  'Serena',
  'Allison',
  'Samantha',
  'Alex',
  'Joelle',
  'Noelle',
  'Evan',
  'Nathan',
  'Tom',
  'Daniel',
  'Karen',
  'Moira',
  'Tessa',
  'Fiona',
  'Rishi',
  'Tara'
]

export function chooseVoice(voices: VoiceOption[]): string | null {
  const english = voices.filter((voice) => voice.language.startsWith('en'))
  for (const quality of ['premium', 'enhanced', 'standard'] as const) {
    for (const base of VOICE_ORDER) {
      const hit = english.find(
        (voice) => voice.quality === quality && voiceBaseName(voice.name) === base
      )
      if (hit) return hit.name
    }
  }
  // A downloaded voice with an unfamiliar name is still better than the default.
  return english.find((voice) => voice.quality !== 'standard')?.name ?? null
}
