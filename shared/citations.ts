/**
 * Citation checking.
 *
 * A model can write "[1]" without having read anything. For a local assistant
 * the only useful definition of a citation is a URL that actually appeared in
 * the evidence this turn, so these helpers extract URLs, normalise them for
 * comparison and count the overlap. Pure and model-free: the same rules are
 * used by the benchmark and by the agent's verify pass.
 */

/** A URL in running text, markdown or a tool result. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi

export interface CitationStats {
  /** Distinct URLs found in the reply. */
  total: number
  /** Distinct URLs that also appeared in the turn's tool output. */
  backed: number
  /** Distinct URLs in the reply that were never seen in tool output. */
  unbacked: number
  /** Normalised keys, for debugging and tests. */
  cited: string[]
  backedKeys: string[]
  unbackedKeys: string[]
  /** Distinct hosts among the backed URLs. */
  backedHosts: number
}

export interface CitationRequirement {
  citations: number
  hosts?: number
  /** Defaults to true: an invented URL fails the answer. */
  fromEvidence?: boolean
}

/**
 * Strip punctuation that belongs to the sentence rather than the URL, and
 * keep balanced brackets that are part of the path (Wikipedia-style).
 */
function trimUrl(raw: string): string {
  let value = raw.trim()
  while (/[.,;:!]$/.test(value)) value = value.slice(0, -1)
  const pairs: [string, string][] = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ]
  for (const [open, close] of pairs) {
    while (value.endsWith(close)) {
      const opens = value.split(open).length - 1
      const closes = value.split(close).length - 1
      if (closes <= opens) break
      value = value.slice(0, -1)
    }
  }
  return value
}

/** A stable comparison key: no scheme, no `www.`, no fragment, no trailing slash. */
export function normaliseUrl(raw: string): string | null {
  try {
    const url = new URL(trimUrl(raw))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!host) return null
    const port = url.port ? `:${url.port}` : ''
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${host}${port}${path}${url.search}`
  } catch {
    return null
  }
}

export function hostOf(raw: string): string | null {
  try {
    return new URL(trimUrl(raw)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Every distinct URL in a piece of text, in first-seen order. */
export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const cleaned = trimUrl(match[0])
    const key = normaliseUrl(cleaned)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(cleaned)
  }
  return result
}

/**
 * Compare the URLs in a reply with the URLs the tools actually returned.
 * Two spellings of the same page count once; a URL that was never read does
 * not count at all.
 */
export function citationStats(text: string, evidenceUrls: string[]): CitationStats {
  const evidence = new Set<string>()
  for (const url of evidenceUrls) {
    const key = normaliseUrl(url)
    if (key) evidence.add(key)
  }

  const seen = new Set<string>()
  const cited: string[] = []
  const backedKeys: string[] = []
  const unbackedKeys: string[] = []
  const hosts = new Set<string>()

  for (const url of extractUrls(text)) {
    const key = normaliseUrl(url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    cited.push(key)
    if (evidence.has(key)) {
      backedKeys.push(key)
      const host = hostOf(url)
      if (host) hosts.add(host)
    } else {
      unbackedKeys.push(key)
    }
  }

  return {
    total: cited.length,
    backed: backedKeys.length,
    unbacked: unbackedKeys.length,
    cited,
    backedKeys,
    unbackedKeys,
    backedHosts: hosts.size
  }
}

/**
 * Why the reply's citations are insufficient, or null when they are fine.
 * The message is shown to the model, so it names the concrete gap.
 */
export function citationFailure(
  text: string,
  evidenceUrls: string[],
  requirement: CitationRequirement
): string | null {
  const required = Math.max(0, Math.floor(requirement.citations))
  if (required === 0) return null
  const stats = citationStats(text, evidenceUrls)
  const fromEvidence = requirement.fromEvidence !== false

  if (fromEvidence && stats.unbacked > 0) {
    return `cited ${stats.unbacked} URL${stats.unbacked === 1 ? '' : 's'} that the tools never returned this turn`
  }
  if (stats.total === 0) {
    return `no source URL was cited (needs ${required} that were actually read)`
  }
  if (stats.backed < required) {
    return `only ${stats.backed}/${required} cited sources were actually read this turn`
  }
  const hosts = Math.max(0, Math.floor(requirement.hosts ?? 0))
  if (hosts > 0 && stats.backedHosts < hosts) {
    return `cited sources come from ${stats.backedHosts} host${stats.backedHosts === 1 ? '' : 's'}, needs ${hosts}`
  }
  return null
}

/** A single sentence the loop can use to ask for the missing citations. */
export function citationNudge(planRequirement: CitationRequirement, evidenceUrls: string[]): string {
  const samples = evidenceUrls
    .map((url) => trimUrl(url))
    .filter((url) => normaliseUrl(url) !== null)
    .slice(0, 3)
  const example = samples.length > 0 ? ` For example: ${samples.map((url) => `[${samples.indexOf(url) + 1}] ${url}`).join(' ')}` : ''
  return `Add the sources you actually read to the answer. Paste the exact URL next to each claim, at least ${planRequirement.citations}. Do not invent links.${example}`
}
