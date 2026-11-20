import { Store } from '../store'
import { rankMemories } from '../../../shared/recall'
import { embed } from './ollama'

interface MemoryEntry {
  text: string
  at: number
  vec: number[]
}

interface MemoryData {
  facts: string[]
  entries: MemoryEntry[]
}

export interface MemoryConfig {
  url: string
  model: string
  /** Lexical by default: no second model is loaded for ordinary recall. */
  mode: 'lexical' | 'semantic'
}

const MAX_ENTRIES = 400
const MAX_FACTS = 60

/**
 * Local long-term memory.
 *
 * Two layers: explicit facts the person asked Lux to remember, and a rolling
 * index of past exchanges. Lexical recall is the default and needs no model.
 * Semantic recall is opt-in because it makes the embedding model resident and
 * can evict the working agent on a 16 GB machine.
 */
export class Memory {
  private readonly store: Store<MemoryData>
  private data: MemoryData
  private queue: Promise<void> = Promise.resolve()

  constructor(
    file: string,
    private readonly config: () => MemoryConfig
  ) {
    this.store = new Store<MemoryData>(file, { facts: [], entries: [] })
    this.data = this.store.read()
    if (!Array.isArray(this.data.facts)) this.data.facts = []
    if (!Array.isArray(this.data.entries)) this.data.entries = []
  }

  facts(): string[] {
    return this.data.facts.slice(-MAX_FACTS)
  }

  hasFact(fact: string): boolean {
    const needle = fact.trim().toLowerCase()
    return this.data.facts.some((existing) => existing.toLowerCase() === needle)
  }

  async addFact(fact: string): Promise<void> {
    const clean = fact.trim()
    if (!clean || this.hasFact(clean)) return
    this.data.facts.push(clean.slice(0, 500))
    if (this.data.facts.length > MAX_FACTS) this.data.facts = this.data.facts.slice(-MAX_FACTS)
    this.persist()
  }

  /** Store a completed exchange. Embedding is only used in semantic mode. */
  async recordExchange(userText: string, assistantText: string): Promise<void> {
    const text = `${userText.trim()}\nLux: ${assistantText.trim().slice(0, 700)}`
    if (text.length < 8) return
    const mode = this.config().mode

    if (mode === 'lexical') {
      this.pushEntry({ text, at: Date.now(), vec: [] })
      return
    }

    this.queue = this.queue.then(async () => {
      try {
        const { url, model } = this.config()
        const [vec] = await embed(url, model, [text.slice(0, 2_000)])
        this.pushEntry({ text, at: Date.now(), vec: vec ?? [] })
      } catch {
        // Embeddings are an enhancement; a missing model must never break a turn.
        this.pushEntry({ text, at: Date.now(), vec: [] })
      }
    })
    await this.queue
  }

  /** Similar past exchanges for the current request, most relevant first. */
  async recall(query: string, k = 4): Promise<string[]> {
    if (this.data.entries.length === 0) return []
    const mode = this.config().mode

    if (mode === 'semantic' && this.data.entries.some((entry) => entry.vec.length > 0)) {
      try {
        const { url, model } = this.config()
        const [vec] = await embed(url, model, [query.slice(0, 2_000)])
        if (vec && vec.length > 0) {
          return this.data.entries
            .filter((entry) => entry.vec.length > 0)
            .map((entry) => ({ entry, score: cosine(vec, entry.vec) }))
            .filter((item) => item.score > 0.55)
            .sort((a, b) => b.score - a.score)
            .slice(0, k)
            .map(({ entry }) => this.summary(entry))
        }
      } catch {
        // Fall through to lexical recall.
      }
    }

    return rankMemories(this.data.entries, query, k).map(({ entry }) => this.summary(entry))
  }

  private summary(entry: MemoryEntry): string {
    const [userLine, assistantLine = ''] = entry.text.split('\n')
    return `${userLine?.slice(0, 200) ?? ''} → ${assistantLine.replace(/^Lux:\s*/, '').slice(0, 200)}`
  }

  private pushEntry(entry: MemoryEntry): void {
    this.data.entries.push(entry)
    if (this.data.entries.length > MAX_ENTRIES) {
      this.data.entries = this.data.entries.slice(-MAX_ENTRIES)
    }
    this.persist()
  }

  private persist(): void {
    this.store.write(this.data)
  }
}

export function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
