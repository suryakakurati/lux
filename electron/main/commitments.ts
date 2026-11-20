import { randomUUID } from 'node:crypto'
import {
  buildBrief,
  commitmentKey,
  extractCommitment,
  openCommitments,
  parseDue,
  type Brief,
  type CapturedCommitment,
  type Commitment,
  type CommitmentSource
} from '../../shared/commitments'
import { Store } from './store'

interface LedgerFile {
  items: Commitment[]
}

export interface AddedCommitment {
  item: Commitment
  duplicate: boolean
}

export interface CapturedResult extends AddedCommitment {
  captured: CapturedCommitment
}

/**
 * The durable commitments ledger.
 *
 * Deliberately a tiny JSON file and no model calls: capture is regex, dates are
 * arithmetic, and the morning brief is composed from what is already stored.
 * That keeps the feature fast and nearly free on a 16 GB Mac.
 */
export class CommitmentLedger {
  private store: Store<LedgerFile>
  private items: Commitment[]

  constructor(file: string) {
    this.store = new Store<LedgerFile>(file, { items: [] })
    const stored = this.store.read()
    this.items = Array.isArray(stored.items)
      ? stored.items.filter(
          (item): item is Commitment =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof item.text === 'string' &&
            (item.status === 'open' || item.status === 'done')
        )
      : []
  }

  all(): Commitment[] {
    return [...this.items]
  }

  open(now = new Date()): Commitment[] {
    return openCommitments(this.items, now)
  }

  capture(text: string, source: CommitmentSource = 'user', now = new Date()): CapturedResult | null {
    const captured = extractCommitment(text, now)
    if (!captured) return null
    const added = this.add(captured.text, captured.dueAt, source, now)
    if (!added) return null
    return { ...added, captured }
  }

  add(text: string, dueAt?: number, source: CommitmentSource = 'tool', now = new Date()): AddedCommitment | null {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 260)
    if (clean.length < 3) return null
    const key = commitmentKey(clean)

    // Saying the same thing twice is a conversation, not two commitments.
    const existing = this.items.find(
      (item) => item.status === 'open' && commitmentKey(item.text) === key
    )
    if (existing) {
      if (dueAt && !existing.dueAt) {
        existing.dueAt = dueAt
        this.save()
      }
      return { item: existing, duplicate: true }
    }

    const item: Commitment = {
      id: `c-${randomUUID().slice(0, 8)}`,
      text: clean,
      createdAt: now.getTime(),
      status: 'open',
      source,
      ...(dueAt ? { dueAt } : {})
    }
    this.items.push(item)
    this.save()
    return { item, duplicate: false }
  }

  complete(target: string, now = new Date()): Commitment | null {
    const item = this.resolve(target, now)
    if (!item) return null
    item.status = 'done'
    item.completedAt = now.getTime()
    delete item.snoozedUntil
    this.save()
    return item
  }

  snooze(target: string, until: number, now = new Date()): Commitment | null {
    const item = this.resolve(target, now)
    if (!item) return null
    item.snoozedUntil = until
    this.save()
    return item
  }

  brief(now = new Date()): Brief {
    return buildBrief(this.items, now)
  }

  /** Match by full ID, unique ID prefix, exact text key, or a text fragment. */
  resolve(target: string, now = new Date()): Commitment | null {
    const value = target.trim()
    if (!value) return null
    const open = this.open(now)
    const key = commitmentKey(value)
    return (
      open.find((item) => item.id === value) ??
      (value.length >= 3 ? open.find((item) => item.id.startsWith(value)) : undefined) ??
      open.find((item) => commitmentKey(item.text) === key) ??
      (key.length >= 3
        ? open.find((item) => commitmentKey(item.text).includes(key))
        : undefined) ??
      null
    )
  }

  /** Natural-language due phrases, or an ISO timestamp when the model sends one. */
  dueFrom(value: string, now = new Date()): number | undefined {
    const text = value.trim()
    if (!text) return undefined
    if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{10,13}$/.test(text)) {
      const parsed = /^\d{13}$/.test(text)
        ? Number(text)
        : /^\d{10}$/.test(text)
          ? Number(text) * 1_000
          : Date.parse(text)
      if (Number.isFinite(parsed)) return parsed
    }
    return parseDue(text, now)
  }

  private save(): void {
    this.store.write({ items: this.items })
  }
}
