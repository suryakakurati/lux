/**
 * Run independent operations with a hard concurrency ceiling.
 *
 * Research needs to fetch several pages, but a fanless 16 GB Air should not
 * open ten Chromium requests or ten network streams at once. Three is enough to
 * hide latency without turning a background task into a thermal event.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const width = Math.max(1, Math.min(Math.floor(limit), items.length))
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}
