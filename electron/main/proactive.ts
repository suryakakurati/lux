import { dateKey, inQuietHours, shouldBrief } from '../../shared/commitments'
import type { CommitmentLedger } from './commitments'
import type { Settings } from '../../shared/types'
import { logLine } from './log'
import type { Session } from './session'
import { Store } from './store'

interface ProactiveFile {
  /** Local day of the last delivered brief. */
  lastBriefDate?: string
  lastBriefAt?: number
  /** Commitment id -> when the reminder was delivered. */
  reminded?: Record<string, number>
}

interface ProactiveDeps {
  dataDir: string
  settings: () => Settings
  session: Session
  commitments: CommitmentLedger
  notify: (title: string, body: string) => void
}

/**
 * The only always-on timer in the feature: once every 30 seconds, decide whether
 * the morning brief is due. It is unref'd and does no work on a normal tick, so
 * it costs a sleeping Mac essentially nothing.
 */
export class Proactive {
  private store: Store<ProactiveFile>
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ProactiveDeps) {
    this.store = new Store<ProactiveFile>(`${deps.dataDir}/proactive.json`, {})
  }

  start(): void {
    this.check()
    this.timer = setInterval(() => this.check(), 30_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Scheduled delivery: respects the configured time, quiet hours and once-a-day rule. */
  check(now = new Date()): boolean {
    const settings = this.deps.settings()
    const state = this.store.read()
    const due = shouldBrief(now, {
      enabled: settings.proactiveEnabled,
      briefTime: settings.morningBriefTime,
      quietStart: settings.quietHoursStart,
      quietEnd: settings.quietHoursEnd,
      lastBriefDate: state.lastBriefDate
    })
    if (!due) {
      this.remind(now)
      return false
    }
    if (this.deps.session.isBusy()) {
      logLine('proactive', 'brief due but a turn is running; will retry')
      return false
    }
    return this.deliver(now)
  }

  /** Manual/debug delivery, bypassing the schedule but never interrupting a turn. */
  force(now = new Date()): boolean {
    return this.deliver(now)
  }

  private deliver(now: Date): boolean {
    const brief = this.deps.session.deliverBrief()
    if (!brief) return false
    this.store.write({ ...this.store.read(), lastBriefDate: dateKey(now), lastBriefAt: now.getTime() })
    logLine('proactive', `brief delivered ${JSON.stringify(brief.summary)}`)
    return true
  }

  /**
   * A due commitment is a deterministic notification, not a model call. One
   * reminder at a time, once per item, and never inside quiet hours.
   */
  private remind(now: Date): void {
    const settings = this.deps.settings()
    if (!settings.proactiveEnabled) return
    if (inQuietHours(now, settings.quietHoursStart, settings.quietHoursEnd)) return
    if (this.deps.session.isBusy()) return

    const state = this.store.read()
    const reminded = state.reminded ?? {}
    const horizon = now.getTime() + 5 * 60_000
    const floor = now.getTime() - 24 * 60 * 60_000
    const item = this.deps.commitments
      .open(now)
      .filter((entry) => entry.dueAt && entry.dueAt >= floor && entry.dueAt <= horizon)
      .filter((entry) => !reminded[entry.id])
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0]
    if (!item) return

    reminded[item.id] = now.getTime()
    const recent = Object.entries(reminded).sort((a, b) => b[1] - a[1]).slice(0, 100)
    this.store.write({ ...state, reminded: Object.fromEntries(recent) })
    this.deps.notify('Lux · reminder', item.text)
    logLine('proactive', `reminder ${item.id} ${JSON.stringify(item.text.slice(0, 160))}`)
  }
}
