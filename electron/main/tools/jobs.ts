import { backgroundJobs } from '../jobs'
import { truncate } from '../mac/exec'
import type { ToolDef } from './types'

/**
 * One tool for the whole background-job lifecycle.
 *
 * A job is a single existing tool run outside the model's current round. The
 * model starts one, keeps working, then asks for its output. It is not a shell:
 * the nested tool passes through the same validation, confirmation and timeout
 * path as a foreground call.
 */
export const jobTools: ToolDef[] = [
  {
    name: 'job',
    description:
      'Run one tool in the background, then list, read or stop it. Use for a long read that can happen while another step is being done. This is not a shell; the nested tool keeps its normal confirmation and timeout.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'start, list, output or stop.',
          enum: ['start', 'list', 'output', 'stop']
        },
        tool: { type: 'string', description: 'Tool to run for action=start.' },
        args: {
          type: 'string',
          description: 'Arguments for that tool as a JSON object, e.g. {"url":"https://example.com"}.'
        },
        label: { type: 'string', description: 'Short human label for the job.' },
        id: { type: 'string', description: 'Job id for output or stop.' }
      },
      required: ['action']
    },
    async run(args, context) {
      const action = String(args.action ?? '').trim()
      if (action === 'start') {
        const tool = String(args.tool ?? '').trim()
        if (!tool) return { content: 'Name the tool to run in the background.', summary: 'missing tool' }
        if (!context.runTool) {
          return {
            content: 'Background jobs are not available in this context.',
            summary: 'jobs unavailable'
          }
        }
        let toolArgs: Record<string, unknown> = {}
        if (typeof args.args === 'string' && args.args.trim()) {
          try {
            const parsed = JSON.parse(args.args)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              toolArgs = parsed as Record<string, unknown>
            } else {
              return { content: 'job args must be a JSON object.', summary: 'invalid job args' }
            }
          } catch {
            return { content: 'job args is not valid JSON.', summary: 'invalid job args' }
          }
        }
        const label = String(args.label ?? tool)
        const job = backgroundJobs.start(label, tool, toolArgs, () => context.runTool!(tool, toolArgs))
        return {
          content: `Started ${job.id} (${tool}). Continue with another step, then read it with action=output and id=${job.id}.`,
          summary: `job ${job.id} started`
        }
      }

      if (action === 'list') {
        const jobs = backgroundJobs.list()
        if (jobs.length === 0) return { content: 'No background jobs.', summary: 'no jobs' }
        return {
          content: jobs
            .map((job) => `${job.id} · ${job.status} · ${job.label} (${job.tool})${job.summary ? ` — ${job.summary}` : ''}`)
            .join('\n'),
          summary: `${jobs.length} jobs`,
          openChat: jobs.length > 4
        }
      }

      const id = String(args.id ?? '').trim()
      if (!id) return { content: `Give the job id for action=${action}.`, summary: 'missing job id' }
      const job = backgroundJobs.get(id)
      if (!job) return { content: `There is no job ${id}.`, summary: 'unknown job' }

      if (action === 'stop') {
        const stopped = backgroundJobs.stop(id)
        return {
          content: stopped
            ? `Stop requested for ${id}. The tool may still finish.`
            : `${id} is already ${job.status}.`,
          summary: stopped ? 'job stop requested' : `job ${job.status}`
        }
      }

      if (action === 'output') {
        const body = job.data ? truncate(job.data, 4_000) : '(no output yet)'
        return {
          content: `${id} · ${job.status} · ${job.label}\n${body}`,
          summary: `job ${job.status}`,
          openChat: body.length > 600
        }
      }

      return { content: 'action must be start, list, output or stop.', summary: 'bad job action' }
    }
  }
]
