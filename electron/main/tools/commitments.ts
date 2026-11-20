import { dueLabel } from '../../../shared/commitments'
import type { ToolDef } from './types'

function formatItem(item: { id: string; text: string; dueAt?: number; snoozedUntil?: number }, now: Date): string {
  const due = dueLabel(item.dueAt, now)
  const snoozed =
    item.snoozedUntil && item.snoozedUntil > now.getTime()
      ? ` · snoozed until ${new Date(item.snoozedUntil).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })}`
      : ''
  return `[${item.id}] ${item.text} — ${due}${snoozed}`
}

export const commitmentTools: ToolDef[] = [
  {
    name: 'commitments',
    description:
      'Keep the person’s open loops: list commitments, add one with a due date, mark one complete, snooze one, or read the morning brief. Use add when they ask you to remember to do something.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What to do with the commitments ledger.',
          enum: ['list', 'add', 'complete', 'snooze', 'brief']
        },
        text: { type: 'string', description: 'The commitment itself, for add. Keep it short and in their words.' },
        due: {
          type: 'string',
          description: 'Optional due phrase for add or snooze: "tomorrow", "Friday at 5pm", "in 2 hours".'
        },
        target: { type: 'string', description: 'Commitment ID or a distinctive part of its text, for complete or snooze.' },
        minutes: { type: 'number', description: 'For snooze: how many minutes to hide it. Defaults to 60.', minimum: 1, maximum: 10_080 }
      },
      required: ['action']
    },
    async run(args, context) {
      const action = String(args.action ?? 'list')
      const now = new Date()
      const ledger = context.commitments

      if (action === 'list') {
        const open = ledger.open(now)
        if (open.length === 0) {
          return { content: 'The commitment ledger is empty.', summary: 'ledger clear' }
        }
        return {
          content: `${open.length} open commitment${open.length === 1 ? '' : 's'}:\n${open
            .map((item) => formatItem(item, now))
            .join('\n')}`,
          summary: `${open.length} open ${open.length === 1 ? 'loop' : 'loops'}`,
          openChat: open.length > 3
        }
      }

      if (action === 'add') {
        const text = String(args.text ?? '').trim()
        if (!text) {
          return { content: 'I need the commitment text to add it.', summary: 'nothing to add' }
        }
        const dueText = String(args.due ?? '').trim()
        const dueAt = dueText ? ledger.dueFrom(dueText, now) : undefined
        const added = ledger.add(text, dueAt, 'tool', now)
        if (!added) {
          return { content: 'That commitment was empty or too short to store.', summary: 'nothing to add' }
        }
        if (added.duplicate) {
          return {
            content: `Already open: ${formatItem(added.item, now)}. No duplicate was added.`,
            summary: 'already on the ledger'
          }
        }
        if (dueText && !dueAt) {
          return {
            content: `Added "${added.item.text}" without a date; I could not read "${dueText}" as a due time.`,
            summary: 'commitment added',
            openChat: false
          }
        }
        return {
          content: `Added ${formatItem(added.item, now)}.`,
          summary: `added · ${dueLabel(added.item.dueAt, now)}`,
          openChat: false
        }
      }

      if (action === 'complete') {
        const target = String(args.target ?? '').trim()
        const item = target ? ledger.complete(target, now) : null
        if (!item) {
          return {
            content: target
              ? `No open commitment matches "${target}". Call commitments with action list to see the IDs.`
              : 'Which commitment should I complete? Pass its ID or a few words from it.',
            summary: 'no match'
          }
        }
        return { content: `Completed: ${item.text}.`, summary: 'commitment completed' }
      }

      if (action === 'snooze') {
        const target = String(args.target ?? '').trim()
        if (!target) {
          return { content: 'Which commitment should I snooze?', summary: 'no target' }
        }
        const dueText = String(args.due ?? '').trim()
        const minutes = Number(args.minutes)
        let until: number
        if (dueText) {
          const parsed = ledger.dueFrom(dueText, now)
          if (!parsed) {
            return { content: `I could not read "${dueText}" as a time to snooze until.`, summary: 'bad snooze time' }
          }
          until = parsed
        } else {
          const wait = Number.isFinite(minutes) && minutes > 0 ? minutes : 60
          until = now.getTime() + wait * 60_000
        }
        const item = ledger.snooze(target, until, now)
        if (!item) {
          return {
            content: `No open commitment matches "${target}". Call commitments with action list to see the IDs.`,
            summary: 'no match'
          }
        }
        return {
          content: `Snoozed "${item.text}" until ${new Date(until).toLocaleString('en-US', {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })}.`,
          summary: 'commitment snoozed'
        }
      }

      if (action === 'brief') {
        const brief = ledger.brief(now)
        return { content: brief.text, summary: brief.summary, openChat: true }
      }

      return {
        content: `Unknown action "${action}". Use list, add, complete, snooze or brief.`,
        summary: 'unknown action'
      }
    }
  }
]
