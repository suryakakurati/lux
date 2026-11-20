import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from './exec'

export interface SqliteRows {
  rows: string[][]
  error?: string
}

/**
 * Query a SQLite file owned by another app.
 *
 * The database is copied before it is opened: Firefox, Chrome and AGNI keep
 * locks and run in WAL mode, and Lux must never write to another app's live
 * database. Rows come back split on a unit separator so a newline inside a
 * title cannot shift the columns.
 */
export async function querySqlite(file: string, sql: string, timeout = 8_000): Promise<SqliteRows> {
  if (!existsSync(file)) return { rows: [], error: `no database at ${file}` }

  const dir = join(tmpdir(), 'lux-sqlite')
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)

  try {
    copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${file}${suffix}`)) copyFileSync(`${file}${suffix}`, `${copy}${suffix}`)
    }
    const result = await exec('/usr/bin/sqlite3', ['-batch', '-separator', '\u001f', copy, sql], { timeout })
    if (result.code !== 0) {
      return { rows: [], error: result.stderr.trim() || `sqlite3 exited with ${result.code}` }
    }
    const rows = result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('\u001f'))
    return { rows }
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    for (const path of [copy, `${copy}-wal`, `${copy}-shm`]) rmSync(path, { force: true })
  }
}

/** Quote a value for a LIKE clause inside a single-quoted SQL string. */
export function sqlLike(value: string): string {
  return `%${value.replace(/'/g, "''")}%`
}
