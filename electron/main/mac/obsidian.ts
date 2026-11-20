import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Find the Obsidian vault this Mac uses.
 *
 * Obsidian keeps its own registry at `~/Library/Application Support/obsidian/
 * obsidian.json`; reading it means Lux works with the real vault without the
 * person having to paste a path into settings.
 */
let cached: string | null = null

export function detectObsidianVault(): string {
  if (cached !== null) return cached
  try {
    const registry = readFileSync(
      join(homedir(), 'Library/Application Support/obsidian/obsidian.json'),
      'utf8'
    )
    const parsed = JSON.parse(registry) as {
      vaults?: Record<string, { path?: string; open?: boolean; ts?: number }>
    }
    const vaults = Object.values(parsed.vaults ?? {}).filter((vault) => vault.path)
    const preferred =
      vaults.find((vault) => vault.open) ??
      vaults.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]
    if (preferred?.path && existsSync(preferred.path)) {
      cached = preferred.path
      return cached
    }
  } catch {
    // No Obsidian, or an unreadable registry: not an error worth surfacing.
  }
  cached = ''
  return cached
}
