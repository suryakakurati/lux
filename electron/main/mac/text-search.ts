import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface TextMatch {
  path: string
  title: string
  score: number
  snippet: string
}

interface SearchOptions {
  /** Stop looking after this long and return what has been found. */
  deadlineMs?: number
  /** Upper bound on files inspected in one call. */
  maxFiles?: number
  /** Parallel reads; the vault can be thousands of files on a synced folder. */
  concurrency?: number
}

async function collectMarkdown(dir: string, out: string[], depth = 0, max: number): Promise<void> {
  if (depth > 8 || out.length >= max) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= max) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectMarkdown(full, out, depth + 1, max)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
}

/**
 * Search markdown files for a phrase.
 *
 * Obsidian vaults are big and often live on a synced folder, so this never
 * blocks on the whole vault: it reads with bounded concurrency, stops at a
 * deadline, and returns partial results rather than making the person wait.
 */
export async function searchMarkdown(
  roots: string[],
  query: string,
  limit: number,
  options: SearchOptions = {}
): Promise<TextMatch[]> {
  const deadlineMs = options.deadlineMs ?? 6_000
  const maxFiles = options.maxFiles ?? 4_000
  const concurrency = options.concurrency ?? 10
  const needle = query.toLowerCase()
  const deadline = Date.now() + deadlineMs

  const files: string[] = []
  for (const root of roots) await collectMarkdown(root, files, 0, maxFiles)

  const unique = [...new Set(files)]
  const queue = unique.slice()
  const matches: TextMatch[] = []

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && Date.now() < deadline) {
      const file = queue.shift()
      if (!file) return
      const title = basename(file, '.md')
      const titleHit = title.toLowerCase().includes(needle)
      let content: string
      try {
        // A file that the file provider has not materialised yet can take
        // seconds; never let one note hold up the whole search.
        content = await Promise.race([
          readFile(file, 'utf8'),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('read timeout')), 1_500))
        ])
      } catch {
        continue
      }
      const haystack = content.toLowerCase()
      if (!titleHit && !haystack.includes(needle)) continue

      const occurrences = haystack.split(needle).length - 1
      const index = haystack.indexOf(needle)
      const start = Math.max(0, index - 110)
      const snippet = content
        .slice(start, index + needle.length + 180)
        .replace(/\s+/g, ' ')
        .trim()

      matches.push({ path: file, title, score: (titleHit ? 10 : 0) + occurrences, snippet })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  return matches.sort((a, b) => b.score - a.score).slice(0, limit)
}
