/**
 * Playbook storage.
 *
 * Seed playbooks ship with the app and are read-only. A playbook the person
 * approves is written to their data directory and shadows a seed with the same
 * id. The cache is short: files are tiny, and an edited playbook should take
 * effect on the next turn rather than after a restart.
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Playbook } from '../../../shared/playbooks'
import { validatePlaybook } from '../../../shared/playbooks'
import { dataDir } from '../config'
import { logLine } from '../log'

const CACHE_MS = 10_000

let cache: { at: number; playbooks: Playbook[] } | null = null

function seedDirs(): string[] {
  const candidates = [
    join(app.getAppPath(), 'playbooks'),
    join(process.resourcesPath ?? '', 'playbooks'),
    join(process.cwd(), 'playbooks')
  ]
  return [...new Set(candidates)].filter((dir) => dir && existsSync(dir))
}

function userDir(): string {
  return join(dataDir(), 'playbooks')
}

function readDir(dir: string): Playbook[] {
  if (!existsSync(dir)) return []
  const result: Playbook[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown
      const validated = validatePlaybook(parsed)
      if (!validated.ok) {
        logLine('playbooks', `${name} ignored: ${validated.error}`)
        continue
      }
      result.push(validated.playbook)
    } catch (error) {
      logLine('playbooks', `${name} ignored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}

/** Seed catalog plus the person's own files, with user playbooks winning. */
export function listPlaybooks(): Playbook[] {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.playbooks
  const merged = new Map<string, Playbook>()
  for (const dir of seedDirs()) {
    for (const playbook of readDir(dir)) merged.set(playbook.id, playbook)
  }
  for (const playbook of readDir(userDir())) merged.set(playbook.id, playbook)
  const playbooks = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
  cache = { at: now, playbooks }
  return playbooks
}

export function savePlaybook(playbook: Playbook): string {
  const validated = validatePlaybook(playbook)
  if (!validated.ok) throw new Error(validated.error)
  const dir = userDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${validated.playbook.id}.json`)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(validated.playbook, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  cache = null
  logLine('playbooks', `saved ${validated.playbook.id} to ${file}`)
  return file
}

/** Drop the cache so the next turn sees a freshly written file. */
export function invalidatePlaybooks(): void {
  cache = null
}
