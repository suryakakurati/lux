import { validateArgs } from '../../../shared/validate'
import { rankTools } from '../../../shared/tool-router'
import { failureEnvelope, successEnvelope } from '../../../shared/tool-envelope'
import { agniTools } from './agni'
import { appTools } from './apps'
import { browseTools } from './browse'
import { commitmentTools } from './commitments'
import { fileTools } from './files'
import { jobTools } from './jobs'
import { mediaTools } from './media'
import { musicTools } from './music'
import { miscTools } from './misc'
import { noteTools } from './notes'
import { playbookTools } from './playbooks'
import { researchTools } from './research'
import { specialistTools } from './specialist'
import { systemTools } from './system'
import { vaultTools } from './vault'
import { webTools } from './web'
import type { ToolCallOutcome, ToolContext, ToolDef, ToolErrorKind } from './types'
import { toOllamaTools } from './types'

/** One tool cannot hold the whole turn hostage. Individual tools may lower this. */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000

export const TOOLS: ToolDef[] = [
  ...appTools,
  ...systemTools,
  ...musicTools,
  ...mediaTools,
  ...webTools,
  ...researchTools,
  ...specialistTools,
  ...browseTools,
  ...agniTools,
  ...commitmentTools,
  ...fileTools,
  ...noteTools,
  ...playbookTools,
  ...vaultTools,
  ...miscTools,
  ...jobTools
]

/** Dynamic capability discovery: the model can ask for schemas it was not offered. */
const discoverTool: ToolDef = {
  name: 'discover_tools',
  description:
    'Discover capabilities that were not in this turn’s shortlist. Ask with a capability description and get the matching tool names, descriptions and argument schemas.',
  risk: 'safe',
  parallelSafe: true,
  timeoutMs: 5_000,
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you need to do, e.g. "read a table on a page" or "write to Obsidian".' },
      limit: { type: 'integer', description: 'How many tools to return (default 5, max 8).', minimum: 1, maximum: 8 }
    },
    required: ['query']
  },
  async run(args) {
    const query = String(args.query ?? '').trim()
    const limit = Math.min(8, Math.max(1, Number(args.limit ?? 5)))
    if (query.length < 2) {
      return { content: 'Describe the capability you need.', summary: 'empty discovery' }
    }
    const ranked = rankTools(query, toOllamaTools(TOOLS))
      .filter((entry) => entry.score > 0)
      .slice(0, limit)
    if (ranked.length === 0) {
      return {
        content: `No tool matched "${query}". Available names: ${TOOLS.map((tool) => tool.name).join(', ')}`,
        summary: 'no tool match'
      }
    }
    return {
      content: [
        `Matching capabilities for "${query}":`,
        JSON.stringify(
          ranked.map((entry) => entry.tool),
          null,
          2
        ),
        'Call the tool you need with those arguments. The tool does not have to have been in the original shortlist.'
      ].join('\n\n'),
      summary: `${ranked.length} matching tools`
    }
  }
}
TOOLS.push(discoverTool)

let definitionCache: ReturnType<typeof toOllamaTools> | null = null
export const toolDefinitions = () => (definitionCache ??= toOllamaTools(TOOLS))

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

/**
 * Execute one model-proposed call.
 *
 * Validation errors and tool failures come back as tool *content* rather than
 * exceptions, so the model can read the failure and correct itself.
 */
export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown>,
  context: ToolContext
): Promise<ToolCallOutcome> {
  const started = Date.now()
  const tool = findTool(name)
  if (!tool) {
    return {
      ...failureEnvelope(
        'unknown_tool',
        `There is no tool called "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
        'Call discover_tools with the capability you need, then call the matching tool.'
      ),
      summary: `unknown tool ${name}`,
      durationMs: Date.now() - started
    }
  }

  const validation = validateArgs(tool.params, rawArgs)
  if (!validation.ok) {
    return {
      ...failureEnvelope(
        'invalid_args',
        `Invalid arguments for ${name}: ${validation.error}`,
        'Correct the arguments to match the schema, then call it once more.'
      ),
      summary: `invalid args: ${name}`,
      durationMs: Date.now() - started
    }
  }

  if (tool.risk === 'confirm') {
    const approved = await context.confirm({
      tool: name,
      args: validation.args,
      reason: String(validation.args.reason ?? `Lux wants to run ${name}.`)
    })
    if (!approved) {
      return {
        ...failureEnvelope(
          'denied',
          'The person declined this action. Do not retry it; ask what they would prefer instead.',
          'Do not retry. Ask what they would prefer instead.'
        ),
        denied: true,
        summary: 'declined',
        durationMs: Date.now() - started
      }
    }
  }

  // A timeout must stop the work, not just stop waiting for it. The controller
  // is chained to the turn's signal, so cancelling a turn also kills the command
  // that turn started.
  const controller = new AbortController()
  const parent = context.signal
  const forwardAbort = (): void => controller.abort()
  if (parent) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', forwardAbort, { once: true })
  }
  const scoped: ToolContext = { ...context, signal: controller.signal }
  const limited = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined

  try {
    const raced = await Promise.race([
      tool.run(validation.args, scoped).then(
        (value) => ({ kind: 'value' as const, value }),
        (error) => ({ kind: 'error' as const, error })
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), limited)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)

    if (raced.kind === 'timeout') {
      controller.abort()
      return {
        ...failureEnvelope(
          'timeout',
          `${name} did not finish within ${Math.round(limited / 1000)}s, so it was stopped.`,
          'Do not repeat it blindly. Try a smaller request or a different tool, and say which step stalled.'
        ),
        summary: `${name} timed out`,
        durationMs: Date.now() - started
      }
    }
    if (raced.kind === 'error') throw raced.error

    const result = raced.value
    // A tool can refuse without throwing (a blocklisted command, a missing
    // argument). That is not evidence the action happened.
    if (result.fail) {
      const hints: Record<ToolErrorKind, string> = {
        unknown_tool: 'Call discover_tools, then the matching tool.',
        invalid_args: 'Correct the arguments to match the schema, then call it once more.',
        denied: 'Do not retry. Ask what they would prefer instead.',
        timeout: 'Do not repeat it blindly. Try a smaller request and name which step stalled.',
        failed: 'Report the failure plainly. Do not claim the action succeeded.'
      }
      return {
        ...failureEnvelope(result.fail, result.content, hints[result.fail]),
        denied: result.fail === 'denied',
        summary: result.summary,
        durationMs: Date.now() - started
      }
    }
    return {
      ...successEnvelope(result.content),
      summary: result.summary,
      openChat: result.openChat,
      durationMs: Date.now() - started
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...failureEnvelope(
        'failed',
        `${name} threw an error: ${message}`,
        'Report the failure plainly. Do not claim the action succeeded.'
      ),
      summary: `${name} failed`,
      durationMs: Date.now() - started
    }
  } finally {
    if (parent) parent.removeEventListener('abort', forwardAbort)
  }
}
