/**
 * Tool shortlisting.
 *
 * Every tool schema is tokens in the prompt, and the full registry costs real latency on
 * a local model: they slow the first token and they dilute the choice. A turn
 * usually needs a handful, so the registry is ranked against the request and
 * only the plausible ones are offered.
 *
 * This is a lossless optimisation: a call to a tool that exists but was not
 * offered still executes (see `executeTool`), so a wrong guess about relevance
 * never blocks the assistant.
 */
/** The shape of a tool schema, kept structural so this module stays pure. */
export interface ToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'yours', 'can', 'could', 'would', 'should', 'will',
  'please', 'with', 'that', 'this', 'these', 'those', 'from', 'have', 'has', 'had', 'was',
  'are', 'were', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'does', 'did',
  'doing', 'done', 'get', 'got', 'give', 'want', 'need', 'like', 'help', 'just', 'now',
  'some', 'any', 'all', 'out', 'into', 'about', 'there', 'here', 'them', 'they', 'its',
  'our', 'not', 'but', 'then', 'than', 'too', 'very', 'also', 'use', 'using', 'make',
  'mac', 'lux', 'thing', 'things', 'stuff', 'something', 'anything', 'much', 'many',
  // "right now" must not select now_playing, and "time" must not prefix-match
  // a timer tool; neither is a capability word on its own.
  'time', 'right'
])

/** Always offered: the tools that answer "what is going on" cheaply. */
const CORE = [
  'open_app',
  'system_status',
  'clipboard_read',
  'discover_tools'
]

/**
 * Capability expansions. The descriptions are short because these are matched
 * against the person's sentence, not shown to the model.
 */
const EXPANSIONS: { pattern: RegExp; names: string[] }[] = [
  {
    pattern: /\b(research|investigat|compare|comparison|latest|news|sources?|developments?|survey|analy[sz]e)\b/i,
    names: ['research', 'web_search', 'web_read', 'browser_open', 'browser_read', 'news_digest', 'discover_tools']
  },
  {
    pattern: /\b(web|website|page|url|link|browse|browser|search|online|internet|site)\b/i,
    names: ['web_search', 'web_read', 'search_web', 'browser_open', 'browser_read', 'browser_click', 'browser_scroll', 'browser_fill', 'browser_submit', 'browser_press', 'browser_inspect', 'browser_back', 'browser_forward', 'site_open', 'discover_tools']
  },
  {
    pattern: /\b(assignments?|grades?|course|class|portal|inbox|email|calendar|deadline|due)\b/i,
    names: ['site_open', 'browser_open', 'history_search', 'browser_read', 'web_read', 'discover_tools']
  },
  {
    pattern: /\b(notes?|vault|obsidian|markdown|write|save|summarize)\b/i,
    names: ['vault_search', 'vault_read', 'vault_write', 'search_notes', 'write_note', 'discover_tools']
  },
  {
    pattern: /\b(files?|folder|document|pdf|find|locate|open)\b/i,
    names: ['find_files', 'open_path', 'quick_look', 'search_notes', 'discover_tools']
  },
  {
    pattern: /\b(timers?|alarms?|remind|countdown|minutes?)\b/i,
    names: ['set_timer', 'list_timers', 'discover_tools']
  },
  {
    pattern: /\b(music|spotify|song|track|album|playlist|listen|play)\b/i,
    names: ['music_taste', 'play_music', 'spotify_search', 'spotify_control', 'now_playing', 'apple_music_control']
  }
]

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .filter((word) => word.length >= 3 && !STOP.has(word))
}

interface Ranked {
  tool: ToolSchema
  score: number
}

function scoreTool(tool: ToolSchema, query: string[]): number {
  const nameTokens = tokens(tool.function.name)
  const descriptionTokens = new Set(tokens(tool.function.description))
  let score = 0
  for (const word of query) {
    for (const part of nameTokens) {
      if (part === word) score += 6
      // Prefixes only count when both words are long enough to mean something:
      // "timer" must not match "time", and "play" must not match "playing".
      else if (part.startsWith(word) && word.length >= 5) score += 3
      else if (word.startsWith(part) && part.length >= 5) score += 3
    }
    if (descriptionTokens.has(word)) score += 1
  }
  return score
}

export function rankTools(query: string, tools: ToolSchema[]): Ranked[] {
  const words = [...new Set(tokens(query))]
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, words) }))
    .sort((a, b) => b.score - a.score)
}

/**
 * The tool set for one turn: core tools plus the best matches, capped.
 *
 * A vague request still gets the core tools plus discover_tools, so nothing is
 * silently unavailable; a failed guess never blocks execution either.
 */
export function shortlistTools(query: string, tools: ToolSchema[], limit = 12): ToolSchema[] {
  if (tools.length <= limit) return tools

  const ranked = rankTools(query, tools)

  const chosen = new Map<string, ToolSchema>()
  for (const name of CORE) {
    if (chosen.size >= limit) break
    const tool = tools.find((candidate) => candidate.function.name === name)
    if (tool) chosen.set(name, tool)
  }

  for (const expansion of EXPANSIONS) {
    if (!expansion.pattern.test(query)) continue
    for (const name of expansion.names) {
      if (chosen.size >= limit) break
      const tool = tools.find((candidate) => candidate.function.name === name)
      if (tool) chosen.set(name, tool)
    }
  }

  for (const { tool, score } of ranked) {
    if (chosen.size >= limit) break
    if (score <= 0) break
    chosen.set(tool.function.name, tool)
  }
  // Order by the registry so the prompt stays stable between similar turns.
  return tools.filter((tool) => chosen.has(tool.function.name))
}
