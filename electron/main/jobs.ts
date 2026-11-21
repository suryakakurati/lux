import { randomUUID } from 'node:crypto'
import type { ToolCallOutcome, ToolErrorKind } from './tools/types'

export type JobStatus = 'running' | 'done' | 'error' | 'stopped'

export interface BackgroundJob {
  id: string
  label: string
  tool: string
  args: Record<string, unknown>
  status: JobStatus
  startedAt: number
  endedAt?: number
  summary?: string
  data?: string
  error_kind?: ToolErrorKind
}

/**
 * A small in-process job registry for long reads.
 *
 * Jobs are deliberately not a second agent loop: one tool call runs in the
 * background and its envelope is kept until the model asks for it. A stop is a
 * request, not a cancellation guarantee — most tools do not expose an abort
 * signal, so the job may finish after being stopped. The status says exactly
 * which of those happened.
 */
export class JobManager {
  private readonly jobs = new Map<string, BackgroundJob>()

  start(
    label: string,
    tool: string,
    args: Record<string, unknown>,
    run: () => Promise<ToolCallOutcome>
  ): BackgroundJob {
    const job: BackgroundJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      label: label.trim() || tool,
      tool,
      args,
      status: 'running',
      startedAt: Date.now()
    }
    this.jobs.set(job.id, job)

    void Promise.resolve()
      .then(run)
      .then(
        (outcome) => {
          job.endedAt ??= Date.now()
          job.data = outcome.data
          job.error_kind = outcome.error_kind
          if (job.status === 'running') {
            job.status = outcome.ok ? 'done' : 'error'
            job.summary = outcome.summary
          }
        },
        (error) => {
          job.endedAt ??= Date.now()
          job.status = 'error'
          job.summary = error instanceof Error ? error.message : String(error)
          job.error_kind = 'failed'
        }
      )

    return { ...job, args: { ...job.args } }
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((job) => ({ ...job, args: { ...job.args } }))
  }

  get(id: string): BackgroundJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job, args: { ...job.args } } : undefined
  }

  /** Request a stop. Returns false when the job already finished. */
  stop(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.status !== 'running') return false
    job.status = 'stopped'
    job.summary = 'stop requested; the tool may still finish'
    job.endedAt = Date.now()
    return true
  }

  reset(): void {
    this.jobs.clear()
  }
}

export const backgroundJobs = new JobManager()
