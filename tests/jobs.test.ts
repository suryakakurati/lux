import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JobManager } from '../electron/main/jobs.ts'
import type { ToolCallOutcome } from '../electron/main/tools/types.ts'

function outcome(data: string): ToolCallOutcome {
  return {
    ok: true,
    data,
    truncated: false,
    summary: `${data.length} chars`,
    durationMs: 3
  }
}

test('a background job moves from running to done and keeps its envelope', async () => {
  const manager = new JobManager()
  let resolve!: (value: ToolCallOutcome) => void
  const pending = new Promise<ToolCallOutcome>((done) => {
    resolve = done
  })
  const job = manager.start('Read example', 'web_read', { url: 'https://example.com' }, () => pending)
  assert.equal(job.status, 'running')
  assert.equal(manager.list().length, 1)

  resolve(outcome('Example Domain'))
  await new Promise((tick) => setTimeout(tick, 10))

  const finished = manager.get(job.id)
  assert.equal(finished?.status, 'done')
  assert.equal(finished?.data, 'Example Domain')
  assert.equal(finished?.label, 'Read example')
})

test('stopping a running job is recorded without pretending it was cancelled', async () => {
  const manager = new JobManager()
  const job = manager.start('Slow read', 'web_read', {}, () => new Promise(() => undefined))
  assert.equal(manager.stop(job.id), true)
  const stopped = manager.get(job.id)
  assert.equal(stopped?.status, 'stopped')
  assert.match(stopped?.summary ?? '', /may still finish/)
  assert.equal(manager.stop(job.id), false)
})
