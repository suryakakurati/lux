import { validateArgs } from '../../../shared/validate'
import { rankTools } from '../../../shared/tool-router'
import { agniTools } from './agni'
import { appTools } from './apps'
import { browseTools } from './browse'
import { commitmentTools } from './commitments'
import { fileTools } from './files'
import { mediaTools } from './media'
import { musicTools } from './music'
import { miscTools } from './misc'
import { noteTools } from './notes'
import { researchTools } from './research'
import { specialistTools } from './specialist'
import { systemTools } from './system'
import { vaultTools } from './vault'
import { webTools } from './web'
import type { ToolCallOutcome, ToolContext, ToolDef } from './types'
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
  ...vaultTools,
  ...miscTools
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
      ok: false,
      summary: `unknown tool ${name}`,
      content: `There is no tool called "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`,
      durationMs: Date.now() - started
    }
  }

  const validation = validateArgs(tool.params, rawArgs)
  if (!validation.ok) {
    return {
      ok: false,
      summary: `invalid args: ${name}`,
      content: `Invalid arguments for ${name}: ${validation.error}`,
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
        ok: false,
        denied: true,
        summary: 'declined',
        content: 'The person declined this action. Do not retry it; ask what they would prefer instead.',
        durationMs: Date.now() - started
      }
    }
  }

  try {
    const limited = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const raced = await Promise.race([
      tool.run(validation.args, context).then(
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
      return {
        ok: false,
        summary: `${name} timed out`,
        content: `${name} did not finish within ${Math.round(limited / 1000)}s, so it was abandoned. Do not repeat it blindly: tell the person which step stalled, or try a different tool.`,
        durationMs: Date.now() - started
      }
    }
    if (raced.kind === 'error') throw raced.error

    const result = raced.value
    return {
      ok: true,
      summary: result.summary,
      content: result.content,
      openChat: result.openChat,
      durationMs: Date.now() - started
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      summary: `${name} failed`,
      content: `${name} threw an error: ${message}`,
      durationMs: Date.now() - started
    }
  }
}
