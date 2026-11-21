/**
 * Tool shortlisting by lexical retrieval.
 *
 * Every tool schema is tokens in the prompt, and the full registry costs real
 * latency on a local model: it slows the first token and dilutes the choice. A
 * turn usually needs a handful, so the registry is ranked against the request
 * and only the plausible ones are offered.
 *
 * The query is expanded with a small capability lexicon rather than a list of
 * intent regexes. A word such as "compare" retrieves the research tools because
 * they are the capabilities that satisfy comparisons, not because a pattern
 * decided what the sentence meant. A failed guess is never a permission
 * boundary: a call to a real tool that was not offered still executes.
 */
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
  // "right now" must not select now_playing, and "time" is not a capability.
  'time', 'right'
])

/** Always offered: the tools that answer "what is going on" cheaply. */
const CORE = ['open_app', 'system_status', 'clipboard_read', 'discover_tools']

/**
 * Capability retrieval. These are synonyms for a need, not sentence patterns:
 * each word simply votes for the tools that can satisfy it.
 */
const ALIASES: Record<string, string[]> = {
  research: ['research', 'web_search', 'web_read', 'news_digest'],
  investigate: ['research', 'web_search', 'web_read'],
  compare: ['research', 'web_search', 'web_read'],
  comparison: ['research', 'web_search', 'web_read'],
  versus: ['research', 'web_search'],
  recommend: ['research', 'web_read'],
  sources: ['research', 'web_read', 'web_search'],
  source: ['research', 'web_read', 'web_search'],
  citations: ['research', 'web_read'],
  references: ['research', 'web_read'],
  latest: ['research', 'web_search', 'news_digest'],
  release: ['research', 'web_search', 'news_digest'],
  changelog: ['research', 'web_search'],
  news: ['news_digest', 'web_search', 'research'],
  article: ['web_read', 'browser_open', 'browser_read'],
  web: ['web_search', 'web_read', 'browse', 'browser_open', 'browser_read', 'site_open'],
  website: ['browse', 'browser_open', 'browser_read', 'web_read', 'site_open'],
  page: ['web_read', 'browser_open', 'browser_read', 'browse'],
  url: ['web_read', 'browse', 'browser_open'],
  link: ['web_read', 'browse', 'browser_open'],
  browse: ['browse', 'browser_open', 'browser_read'],
  browser: ['browser_open', 'browser_read', 'browse', 'site_open'],
  search: ['web_search', 'browse', 'search_notes', 'history_search'],
  online: ['web_search', 'browse', 'web_read'],
  internet: ['web_search', 'browse'],
  site: ['site_open', 'browser_open', 'browse'],
  assignment: ['site_open', 'browser_open', 'browser_read', 'history_search'],
  assignments: ['site_open', 'browser_open', 'browser_read', 'history_search'],
  course: ['site_open', 'browser_open', 'browser_read'],
  portal: ['site_open', 'browser_open', 'browser_read'],
  email: ['site_open', 'browser_open', 'browser_read'],
  calendar: ['site_open', 'browser_open', 'browser_read'],
  deadline: ['commitments', 'site_open'],
  notes: ['search_notes', 'vault_search', 'vault_read', 'write_note'],
  note: ['search_notes', 'vault_search', 'vault_read', 'write_note'],
  vault: ['vault_search', 'vault_read', 'vault_write'],
  obsidian: ['vault_search', 'vault_read', 'vault_write'],
  markdown: ['vault_search', 'vault_read', 'write_note'],
  summarize: ['web_read', 'research', 'vault_read'],
  summarise: ['web_read', 'research', 'vault_read'],
  files: ['find_files', 'open_path', 'quick_look'],
  file: ['find_files', 'open_path', 'quick_look'],
  folder: ['find_files', 'open_path'],
  document: ['find_files', 'open_path'],
  pdf: ['find_files', 'open_path'],
  find: ['find_files', 'search_notes', 'vault_search'],
  locate: ['find_files', 'open_path'],
  timers: ['timer'],
  timer: ['timer'],
  alarm: ['timer'],
  remind: ['timer', 'commitments'],
  countdown: ['timer'],
  minutes: ['timer'],
  music: ['music_taste', 'play_music', 'spotify_search', 'spotify_control', 'now_playing', 'apple_music_control'],
  spotify: ['music_taste', 'play_music', 'spotify_search', 'spotify_control', 'now_playing'],
  song: ['play_music', 'spotify_search', 'now_playing'],
  track: ['play_music', 'spotify_search', 'now_playing'],
  album: ['play_music', 'spotify_search'],
  playlist: ['play_music', 'spotify_search', 'music_taste'],
  listen: ['music_taste', 'play_music', 'now_playing'],
  play: ['play_music', 'spotify_search', 'spotify_control'],
  battery: ['system_status', 'battery_status'],
  volume: ['system_status', 'get_volume'],
  cpu: ['system_status'],
  memory: ['system_status'],
  disk: ['system_status'],
  clipboard: ['clipboard_read', 'clipboard_write'],
  shell: ['run_shell'],
  command: ['run_shell'],
  screenshot: ['take_screenshot'],
  jobs: ['job'],
  background: ['job'],
  playbooks: ['list_playbooks'],
  playbook: ['list_playbooks', 'save_playbook']
}

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
 * The tool set for one turn: core tools, capability matches, then lexical
 * matches, capped. An unrecognised request still has the core tools plus
 * discover_tools, so nothing is silently unavailable.
 */
export function shortlistTools(query: string, tools: ToolSchema[], limit = 12): ToolSchema[] {
  if (tools.length <= limit) return tools

  const words = [...new Set(tokens(query))]
  const chosen = new Map<string, ToolSchema>()

  for (const name of CORE) {
    if (chosen.size >= limit) break
    const tool = tools.find((candidate) => candidate.function.name === name)
    if (tool) chosen.set(name, tool)
  }

  for (const word of words) {
    for (const name of ALIASES[word] ?? []) {
      if (chosen.size >= limit) break
      const tool = tools.find((candidate) => candidate.function.name === name)
      if (tool) chosen.set(name, tool)
    }
  }

  for (const { tool, score } of rankTools(query, tools)) {
    if (chosen.size >= limit) break
    if (score <= 0) break
    chosen.set(tool.function.name, tool)
  }

  return tools.filter((tool) => chosen.has(tool.function.name))
}
