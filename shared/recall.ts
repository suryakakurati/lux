/**
 * Deterministic lexical recall.
 *
 * Semantic embeddings are useful, but they cost a second resident model and an
 * extra Ollama round trip on every turn. For a few hundred short exchanges,
 * term overlap with recency is fast, explainable and good enough to surface
 * "the project I mentioned last week". Semantic recall remains available as an
 * opt-in setting; this is the default.
 */

const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'yours', 'can', 'could', 'would', 'should', 'will',
  'please', 'with', 'that', 'this', 'these', 'those', 'from', 'have', 'has', 'had', 'was',
  'are', 'were', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'does', 'did',
  'doing', 'done', 'get', 'got', 'give', 'want', 'need', 'like', 'help', 'just', 'now',
  'some', 'any', 'all', 'out', 'into', 'about', 'there', 'here', 'them', 'they', 'its',
  'our', 'not', 'but', 'then', 'than', 'too', 'very', 'also', 'use', 'using', 'make',
  'mac', 'lux', 'thing', 'things', 'stuff', 'something', 'anything', 'much', 'many'
])

export interface RecallEntry {
  text: string
  at: number
}

export function recallTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3 && !STOP.has(word))
}

export function lexicalScore(query: string, text: string): number {
  const wanted = new Set(recallTerms(query))
  if (wanted.size === 0) return 0
  const present = new Set(recallTerms(text))
  let overlap = 0
  for (const word of wanted) if (present.has(word)) overlap += 1
  if (overlap === 0) return 0
  const coverage = overlap / wanted.size
  const density = overlap / Math.max(1, present.size)
  return coverage * 0.8 + density * 0.2
}

export function rankMemories<T extends RecallEntry>(
  entries: T[],
  query: string,
  limit = 4
): { entry: T; score: number }[] {
  const now = Date.now()
  return entries
    .map((entry) => {
      const ageDays = Math.max(0, now - entry.at) / 86_400_000
      const recency = Math.max(0, 0.08 - ageDays * 0.002)
      return { entry, score: lexicalScore(query, entry.text) + recency }
    })
    .filter((item) => item.score >= 0.2)
    .sort((a, b) => b.score - a.score || b.entry.at - a.entry.at)
    .slice(0, limit)
}
