/**
 * Ollama 0.33.3+ reports `prompt_eval_count` as the total prompt tokens and
 * `prompt_eval_cached_count` as the subset served from the prompt cache. Older
 * runners omit the cached field; return undefined rather than inventing a rate.
 */
export function cacheReusePercent(
  cachedCount: number | undefined,
  totalCount: number | undefined
): number | undefined {
  if (
    !Number.isFinite(cachedCount) ||
    !Number.isFinite(totalCount) ||
    cachedCount === undefined ||
    totalCount === undefined ||
    totalCount <= 0
  ) {
    return undefined
  }
  return Math.max(0, Math.min(100, Math.round((Math.max(0, cachedCount) / totalCount) * 100)))
}
