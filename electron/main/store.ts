import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny durable JSON store.
 *
 * Writes go to a sibling temp file and are renamed into place, so a crash mid
 * write can never leave a truncated settings or conversation file behind.
 */
export class Store<T> {
  private readonly file: string
  private readonly fallback: T

  constructor(file: string, fallback: T) {
    this.file = file
    this.fallback = fallback
  }

  read(): T {
    try {
      if (!existsSync(this.file)) return structuredClone(this.fallback)
      const raw = readFileSync(this.file, 'utf8')
      if (!raw.trim()) return structuredClone(this.fallback)
      return JSON.parse(raw) as T
    } catch (error) {
      console.error(`[store] could not read ${this.file}:`, error)
      return structuredClone(this.fallback)
    }
  }

  write(value: T): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error(`[store] could not write ${this.file}:`, error)
    }
  }
}
