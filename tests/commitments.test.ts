import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildBrief,
  commitmentKey,
  dateKey,
  dueLabel,
  extractCommitment,
  inQuietHours,
  openCommitments,
  parseDue,
  shouldBrief,
  type Commitment
} from '../shared/commitments.ts'

/** Local time on purpose: the ledger and quiet hours are local-day concepts. */
const WEDNESDAY = new Date(2026, 10, 18, 8, 30, 0)

const item = (overrides: Partial<Commitment>): Commitment => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  text: overrides.text ?? 'something',
  createdAt: overrides.createdAt ?? WEDNESDAY.getTime(),
  status: overrides.status ?? 'open',
  source: overrides.source ?? 'user',
  ...overrides
})

test('a reminder sentence becomes a commitment with its due date', () => {
  const captured = extractCommitment('Remind me to email the project lead about the extension tomorrow', WEDNESDAY)
  assert.ok(captured)
  assert.match(captured.text, /email the project lead/)
  assert.equal(new Date(captured.dueAt!).getDate(), 19)
  assert.equal(new Date(captured.dueAt!).getHours(), 23)
})

test('an obligation with a weekday is captured', () => {
  const captured = extractCommitment('I need to finish the report by Friday', WEDNESDAY)
  assert.ok(captured)
  assert.equal(captured.text, 'finish the report by Friday')
  const due = new Date(captured.dueAt!)
  assert.equal(due.getDay(), 5)
  assert.ok(due.getTime() > WEDNESDAY.getTime())
})

test('a plain plan without a future marker is not a commitment', () => {
  assert.equal(extractCommitment("I'll play some music", WEDNESDAY), null)
  assert.equal(extractCommitment("I'll be there", WEDNESDAY), null)
})

test('questions and negations never enter the ledger', () => {
  assert.equal(extractCommitment('Do I need to email him?', WEDNESDAY), null)
  assert.equal(extractCommitment("I don't need to do that", WEDNESDAY), null)
  assert.equal(extractCommitment("I won't forget to call", WEDNESDAY), null)
})

test('"I have … due …" keeps the object and the date', () => {
  const captured = extractCommitment('I have a paper due Friday', WEDNESDAY)
  assert.ok(captured)
  assert.equal(captured.text, 'a paper')
  assert.equal(new Date(captured.dueAt!).getDay(), 5)
})

test('relative due times are arithmetic, not guesses', () => {
  const due = parseDue('in 2 hours', WEDNESDAY)
  assert.equal(due, WEDNESDAY.getTime() + 2 * 3_600_000)
})

test('"tomorrow at 5pm" keeps both parts', () => {
  const due = new Date(parseDue('submit it tomorrow at 5pm', WEDNESDAY)!)
  assert.equal(due.getDate(), 19)
  assert.equal(due.getHours(), 17)
})

test('a weekday time that already passed points to next week', () => {
  const fridayEvening = new Date(2026, 10, 20, 18, 0)
  const due = new Date(parseDue('Friday at 5pm', fridayEvening)!)
  assert.equal(due.getDay(), 5)
  assert.equal(due.getDate(), 27)
  assert.ok(due.getTime() > fridayEvening.getTime())
})

test('tonight is this evening, not the end of the day', () => {
  const due = new Date(parseDue("I'll call mom tonight", WEDNESDAY)!)
  assert.equal(due.getDate(), 18)
  assert.equal(due.getHours(), 21)
})

test('duplicate keys ignore case, punctuation and a leading article', () => {
  assert.equal(commitmentKey('Email  the TA!'), commitmentKey('email the ta'))
  assert.equal(commitmentKey('A paper'), 'paper')
})

test('quiet hours work across midnight', () => {
  assert.equal(inQuietHours(new Date(2026, 10, 18, 22, 30), '22:00', '08:00'), true)
  assert.equal(inQuietHours(new Date(2026, 10, 18, 7, 59), '22:00', '08:00'), true)
  assert.equal(inQuietHours(new Date(2026, 10, 18, 8, 0), '22:00', '08:00'), false)
  assert.equal(inQuietHours(new Date(2026, 10, 18, 21, 59), '22:00', '08:00'), false)
  assert.equal(inQuietHours(new Date(2026, 10, 18, 12, 0), '08:00', '08:00'), false)
})

test('the brief fires once, after its time, outside quiet hours', () => {
  const base = {
    enabled: true,
    briefTime: '08:30',
    quietStart: '22:00',
    quietEnd: '08:00',
    lastBriefDate: undefined
  }
  assert.equal(shouldBrief(new Date(2026, 10, 18, 8, 30), base), true)
  assert.equal(shouldBrief(new Date(2026, 10, 18, 8, 29), base), false)
  assert.equal(shouldBrief(new Date(2026, 10, 18, 12, 0), base), false)
  assert.equal(shouldBrief(new Date(2026, 10, 18, 8, 30), { ...base, lastBriefDate: '2026-11-18' }), false)
  assert.equal(shouldBrief(new Date(2026, 10, 18, 8, 30), { ...base, enabled: false }), false)
  // A Mac asleep at 08:30 still gets the brief when it wakes at 09:15…
  assert.equal(shouldBrief(new Date(2026, 10, 18, 9, 15), base), true)
  // …and a brief configured inside quiet hours waits for quiet to end.
  assert.equal(
    shouldBrief(new Date(2026, 10, 18, 7, 30), { ...base, briefTime: '07:30' }),
    false
  )
  assert.equal(
    shouldBrief(new Date(2026, 10, 18, 8, 1), { ...base, briefTime: '07:30' }),
    true
  )
})

test('the brief separates overdue, today, upcoming and undated items', () => {
  const yesterday = new Date(2026, 10, 17, 17, 0).getTime()
  const today = new Date(2026, 10, 18, 17, 0).getTime()
  const tomorrow = new Date(2026, 10, 19, 12, 0).getTime()
  const items = [
    item({ text: 'Email the professor', dueAt: yesterday }),
    item({ text: 'Finish the report', dueAt: today }),
    item({ text: 'Renew the library book', dueAt: tomorrow }),
    item({ text: 'Call the bank' }),
    item({ text: 'Already finished', status: 'done', dueAt: yesterday }),
    item({ text: 'Snoozed until later', snoozedUntil: WEDNESDAY.getTime() + 3_600_000 })
  ]

  const brief = buildBrief(items, WEDNESDAY)
  assert.equal(brief.overdue, 1)
  assert.equal(brief.dueToday, 1)
  assert.equal(brief.upcoming, 1)
  assert.equal(brief.undated, 1)
  assert.match(brief.text, /1 thing is overdue/)
  assert.match(brief.text, /1 thing is due today/)
  assert.match(brief.text, /Coming up/)
  assert.match(brief.text, /Call the bank/)
  assert.doesNotMatch(brief.text, /Already finished/)
  assert.doesNotMatch(brief.text, /Snoozed until later/)
  assert.equal(brief.summary, '1 overdue · 1 due today')
})

test('an empty ledger says so plainly', () => {
  const brief = buildBrief([], WEDNESDAY)
  assert.equal(brief.summary, 'clear day')
  assert.match(brief.text, /ledger is clear/)
})

test('open items sort by due date, undated last', () => {
  const items = [
    item({ id: 'c', text: 'undated' }),
    item({ id: 'b', text: 'tomorrow', dueAt: new Date(2026, 10, 19).getTime() }),
    item({ id: 'a', text: 'today', dueAt: new Date(2026, 10, 18).getTime() })
  ]
  assert.deepEqual(
    openCommitments(items, WEDNESDAY).map((entry) => entry.id),
    ['a', 'b', 'c']
  )
})

test('due labels are relative and stable', () => {
  assert.equal(dueLabel(new Date(2026, 10, 17, 12).getTime(), WEDNESDAY), 'overdue')
  assert.equal(dueLabel(new Date(2026, 10, 18, 23).getTime(), WEDNESDAY), 'today')
  assert.equal(dueLabel(new Date(2026, 10, 19, 12).getTime(), WEDNESDAY), 'tomorrow')
  assert.equal(dueLabel(undefined, WEDNESDAY), 'no date')
})

test('the local day key is stable', () => {
  assert.equal(dateKey(new Date(2026, 10, 18, 23, 59)), '2026-11-18')
})
