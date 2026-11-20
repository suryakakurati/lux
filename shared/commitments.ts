/**
 * Deterministic commitments ("open loops") and the morning brief.
 *
 * Nothing here calls a model. A personal assistant that forgets what you told it
 * is worse than no assistant, so capture, dates, quiet hours and briefing are
 * rules and arithmetic: fast, testable, and free of the 16 GB machine's model
 * budget. The model may *talk* about these items; it does not decide them.
 */

export type CommitmentStatus = 'open' | 'done'
export type CommitmentSource = 'user' | 'tool'

export interface Commitment {
  id: string
  text: string
  createdAt: number
  dueAt?: number
  status: CommitmentStatus
  source: CommitmentSource
  completedAt?: number
  /** Hidden until this time; still open. */
  snoozedUntil?: number
}

export interface CapturedCommitment {
  text: string
  dueAt?: number
}

export interface Brief {
  text: string
  summary: string
  overdue: number
  dueToday: number
  upcoming: number
  undated: number
}

export interface BriefSchedule {
  enabled: boolean
  briefTime: string
  quietStart: string
  quietEnd: string
  /** Local day key (YYYY-MM-DD) of the last delivered brief. */
  lastBriefDate?: string
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** One canonical form for duplicate detection: case, punctuation and articles gone. */
export function commitmentKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export function endOfDay(date: Date): Date {
  const copy = new Date(date)
  copy.setHours(23, 59, 59, 999)
  return copy
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date)
  copy.setDate(copy.getDate() + days)
  return copy
}

export function dateKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes()
}

/** "08:30" / "8:30" / "08:30:00" → minutes since midnight, or null. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** Quiet hours may cross midnight (22:00 → 08:00). Equal times mean "off". */
export function inQuietHours(now: Date, quietStart: string, quietEnd: string): boolean {
  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  if (start === null || end === null || start === end) return false
  const current = minutesOfDay(now)
  return start < end ? current >= start && current < end : current >= start || current < end
}

/**
 * Whether the morning brief is due now.
 *
 * The three-hour window is deliberate: a Mac asleep at 08:30 should still brief
 * at 09:15, but opening the lid at 21:00 should not produce a "morning" brief.
 * Quiet hours always win, and a brief is delivered at most once per local day.
 */
export function shouldBrief(now: Date, schedule: BriefSchedule): boolean {
  if (!schedule.enabled) return false
  if (inQuietHours(now, schedule.quietStart, schedule.quietEnd)) return false
  const briefMinutes = parseClock(schedule.briefTime)
  if (briefMinutes === null) return false
  const current = minutesOfDay(now)
  if (current < briefMinutes || current > briefMinutes + 180) return false
  return schedule.lastBriefDate !== dateKey(now)
}

interface ParsedTime {
  hour: number
  minute: number
}

/** A clock time written as "at 5", "at 5pm", "17:30", "by 9 am". */
function parseTime(text: string): ParsedTime | null {
  const withMeridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  const explicit = /\b(?:at|by|around)\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(text)
  const match = withMeridiem ?? explicit
  if (!match) return null

  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  const meridiem = (match[3] ?? '').toLowerCase()
  if (meridiem === 'am' && hour === 12) hour = 0
  else if (meridiem === 'pm' && hour < 12) hour += 12
  else if (!meridiem) {
    // "at 5" is after work far more often than before sunrise.
    if (hour < 8) hour += 12
  }
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/**
 * Turn the date phrase in a sentence into a timestamp.
 *
 * Conservative by design: an unparseable phrase leaves the item undated rather
 * than inventing a deadline. Supported: today, tonight, tomorrow, weekdays,
 * next week, "in N minutes/hours/days", and an explicit clock time.
 */
export function parseDue(text: string, now = new Date()): number | undefined {
  const value = text.toLowerCase()

  const relative = /\bin\s+(\d+)\s+(minute|hour|day|week)s?\b/.exec(value)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]
    const ms = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : unit === 'day' ? 86_400_000 : 604_800_000
    return now.getTime() + amount * ms
  }

  const weekdayMatch = /\b(?:on|by|this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(value)
  const weekday = weekdayMatch ? WEEKDAYS.indexOf(weekdayMatch[1]) : -1

  const clock = parseTime(value)

  if (weekday >= 0) {
    let base = addDays(now, (weekday - now.getDay() + 7) % 7)
    if (clock) base.setHours(clock.hour, clock.minute, 0, 0)
    else base = endOfDay(base)
    // A weekday name always points forward: Friday evening refers to next week.
    if (base.getTime() <= now.getTime() + 30_000) base = addDays(base, 7)
    // "next Friday" means the week after the coming one.
    if (/\bnext\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(value)) {
      base = addDays(base, 7)
    }
    return base.getTime()
  }

  let base: Date | null = null
  let defaultHour = 23
  let defaultMinute = 59

  if (/\btomorrow\b/.test(value)) base = addDays(now, 1)
  else if (/\btonight\b/.test(value)) {
    base = new Date(now)
    defaultHour = 21
    defaultMinute = 0
  } else if (/\btoday\b/.test(value)) base = new Date(now)
  else if (/\bnext week\b/.test(value)) base = addDays(now, 7)

  if (!base) {
    if (!clock) return undefined
    const candidate = new Date(now)
    candidate.setHours(clock.hour, clock.minute, 0, 0)
    if (candidate.getTime() <= now.getTime() + 30_000) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }

  base.setHours(clock?.hour ?? defaultHour, clock?.minute ?? defaultMinute, 0, 0)
  if (base.getTime() <= now.getTime() + 30_000) {
    // "today" and "tonight" written after the time has passed mean tomorrow;
    // an explicit "tomorrow" is still tomorrow.
    if (!/\btomorrow\b/.test(value)) base.setDate(base.getDate() + 1)
  }
  return base.getTime()
}

/** A second person said they would do this, or a question is not a commitment. */
function looksLikeQuestion(text: string): boolean {
  if (text.endsWith('?')) return true
  return /^(?:what|when|where|who|why|how|do|does|did|can|could|should|would|will|is|are|was|were)\b/i.test(
    text
  )
}

function looksNegated(text: string): boolean {
  return /^(?:no\b|nope\b|not\b|i\s+(?:don'?t|do not|won'?t|will not|am not|'m not)\b|i'?m not\b)/i.test(
    text
  )
}

/** An action with no future marker is usually something they are doing now. */
const FUTURE =
  /\b(tomorrow|tonight|later|next week|next month|this (?:morning|afternoon|evening)|after|before|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|the end)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i

/**
 * Rule-based capture from the person's own sentence.
 *
 * Only explicit first-person commitments are taken: "remind me to…",
 * "don't forget…", "I need to…", "I should…", "I'll … tomorrow", "follow up…",
 * and "I have … due …". A question, a negation, or a bare "I'll" with no future
 * marker is ignored, so ordinary conversation does not fill the ledger.
 */
export function extractCommitment(text: string, now = new Date()): CapturedCommitment | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length < 6 || clean.length > 400) return null
  if (looksLikeQuestion(clean) || looksNegated(clean)) return null

  let action = ''
  const patterns: { pattern: RegExp; needsFuture?: boolean }[] = [
    { pattern: /^(?:please\s+)?remind me (?:to|about)\s+(.+)$/i },
    { pattern: /^(?:please\s+)?(?:don'?t|do not) forget (?:to|about)\s+(.+)$/i },
    { pattern: /^i (?:really )?(?:need|have|got) to\s+(.+)$/i },
    { pattern: /^i (?:should|must|ought to)\s+(.+)$/i },
    { pattern: /^i(?:'ll| will)\s+(.+)$/i, needsFuture: true },
    { pattern: /^(?:i (?:need|have) to\s+)?follow up (?:with|on)\s+(.+)$/i },
    { pattern: /^i have (.+?) due\b/i }
  ]

  for (const { pattern, needsFuture } of patterns) {
    const match = pattern.exec(clean)
    if (!match) continue
    if (needsFuture && !FUTURE.test(clean)) continue
    action = match[1].trim()
    break
  }

  if (!action) return null
  action = action
    .replace(/^to\s+/i, '')
    .replace(/^[\s"'“”]+|[\s"'“”.,;:!]+$/g, '')
    .trim()
  if (action.length < 3 || action.length > 260) return null

  return { text: action, dueAt: parseDue(clean, now) }
}

/** Items that are open and not currently snoozed, soonest first. */
export function openCommitments(items: Commitment[], now = new Date()): Commitment[] {
  return items
    .filter(
      (item) =>
        item.status === 'open' && (!item.snoozedUntil || item.snoozedUntil <= now.getTime())
    )
    .sort((a, b) => {
      const aDue = a.dueAt ?? Number.MAX_SAFE_INTEGER
      const bDue = b.dueAt ?? Number.MAX_SAFE_INTEGER
      return aDue - bDue || a.createdAt - b.createdAt
    })
}

/** Human date for the ledger list and the brief. */
export function dueLabel(dueAt: number | undefined, now = new Date()): string {
  if (!dueAt) return 'no date'
  const due = new Date(dueAt)
  if (due.getTime() < startOfDay(now).getTime()) return 'overdue'
  if (due.getTime() <= endOfDay(now).getTime()) return 'today'
  if (due.getTime() <= endOfDay(addDays(now, 1)).getTime()) return 'tomorrow'
  const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (days > 0 && days < 7) return DAY_NAMES[due.getDay()]
  return `${due.getDate()} ${MONTH_NAMES[due.getMonth()]}`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function formatBriefDate(now: Date): string {
  return `${DAY_NAMES[now.getDay()]}, ${now.getDate()} ${MONTH_NAMES[now.getMonth()]}`
}

function line(item: Commitment, now: Date): string {
  return `• ${item.text}${item.dueAt ? ` — ${dueLabel(item.dueAt, now)}` : ''}`
}

/**
 * The morning brief, composed entirely from the ledger.
 *
 * Capped so it stays readable in a notification and in the HUD. Dates are
 * compared by local day, not by 24-hour windows, so "today" means today even
 * when the brief is delivered at 08:30.
 */
export function buildBrief(items: Commitment[], now = new Date()): Brief {
  const open = openCommitments(items, now)
  const overdue = open.filter((item) => item.dueAt && item.dueAt < startOfDay(now).getTime())
  const today = open.filter(
    (item) =>
      item.dueAt &&
      item.dueAt >= startOfDay(now).getTime() &&
      item.dueAt <= endOfDay(now).getTime()
  )
  const upcoming = open.filter(
    (item) =>
      item.dueAt &&
      item.dueAt > endOfDay(now).getTime() &&
      item.dueAt <= endOfDay(addDays(now, 7)).getTime()
  )
  const undated = open.filter((item) => !item.dueAt)

  const lines: string[] = [`Good morning. ${formatBriefDate(now)}.`]

  if (overdue.length > 0) {
    lines.push('', `${plural(overdue.length, 'thing is', 'things are')} overdue:`)
    overdue.slice(0, 3).forEach((item) => lines.push(line(item, now)))
  }

  if (today.length > 0) {
    lines.push('', `${plural(today.length, 'thing is', 'things are')} due today:`)
    today.slice(0, 4).forEach((item) => lines.push(line(item, now)))
  }

  if (upcoming.length > 0) {
    lines.push('', 'Coming up:')
    upcoming.slice(0, 3).forEach((item) => lines.push(line(item, now)))
  }

  if (undated.length > 0) {
    lines.push(
      '',
      `${plural(undated.length, 'open loop has', 'open loops have')} no date${undated.length <= 2 ? `: ${undated.map((item) => item.text).join('; ')}` : '.'}`
    )
  }

  if (overdue.length === 0 && today.length === 0 && upcoming.length === 0 && undated.length === 0) {
    lines.push('', 'The ledger is clear. Nothing is due today.')
  } else if (overdue.length === 0 && today.length === 0 && upcoming.length === 0) {
    lines.push('', 'Nothing is due this week.')
  }

  const summary =
    overdue.length === 0 && today.length === 0
      ? open.length === 0
        ? 'clear day'
        : `${plural(open.length, 'open loop', 'open loops')} · nothing due today`
      : [overdue.length > 0 ? `${overdue.length} overdue` : '', today.length > 0 ? `${today.length} due today` : '']
          .filter(Boolean)
          .join(' · ')

  return {
    text: lines.join('\n'),
    summary,
    overdue: overdue.length,
    dueToday: today.length,
    upcoming: upcoming.length,
    undated: undated.length
  }
}
