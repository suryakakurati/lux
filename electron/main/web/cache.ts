/** A tiny TTL cache. In-memory on purpose: caches must never become stale files. */
export interface TtlEntry<T> {
  value: T
  expires: number
}

export class TtlCache<T> {
  private readonly entries = new Map<string, TtlEntry<T>>()
  private readonly max: number

  constructor(max = 80) {
    this.max = max
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expires <= now) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number, now = Date.now()): void {
    this.entries.set(key, { value, expires: now + ttlMs })
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
