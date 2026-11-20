/**
 * Phrases that mean the model claimed it could not look at something.
 *
 * These are the failure mode that made Lux tell the person to check a site
 * themselves. They are dangerous twice over: wrong once, and then self-reinforcing
 * because every later turn reads them back as its own precedent.
 */
const OBSOLETE_REFUSALS: RegExp[] = [
  /can(?:'|no)?t (?:see|access|view|read|browse|open|check)/i,
  /unable to (?:see|access|view|read|browse|open|check)/i,
  /don'?t have (?:direct )?access/i,
  /(?:need to|should|have to|will need to) (?:log ?in|sign ?in|check)/i,
  /I (?:can'?t|cannot) (?:open|read|check|access)/i
]

/** True when a reply is a refusal to look rather than an answer. */
export function isObsoleteRefusal(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  return OBSOLETE_REFUSALS.some((pattern) => pattern.test(value))
}

/** Words that mean the question lives on a website the person already signed into. */
const NEEDS_SITE = /\b(assignments?|homework|hw\d*|deadlines?|due|grades?|email|inbox|calendar|tickets?|jira|notion|portal|course|class)\b/i

export function needsSiteCheck(text: string): boolean {
  return NEEDS_SITE.test(text)
}

/**
 * Words that mean the request is about the person's own listening, which Lux
 * can read from disk instead of interviewing them about their taste.
 */
const NEEDS_MUSIC = /\b(music|song|songs|artist|album|playlist|spotify|listening|listened|taste|vibes?|genre|track|tracks|listen)\b/i

export function needsMusicTaste(text: string): boolean {
  return NEEDS_MUSIC.test(text)
}
