import type { ToolSchema } from '../shared/tool-router.ts'

export interface EvalCase {
  id: string
  prompt: string
  playbook?: string
  tool?: string
  answerOnly?: boolean
  clarify?: boolean
  citations?: number
}

function tool(name: string, description: string): ToolSchema {
  return { type: 'function', function: { name, description, parameters: { type: 'object' } } }
}

/** A stable, small slice of the real capability surface. */
export const EVAL_TOOLS: ToolSchema[] = [
  tool('system_status', 'Report CPU, memory, disk, battery and volume.'),
  tool('battery_status', 'Read the battery percentage and charging state.'),
  tool('get_volume', 'Read the output volume.'),
  tool('clipboard_read', 'Read the current clipboard text.'),
  tool('find_files', 'Find files by name on this Mac.'),
  tool('web_read', 'Read a public web page and return its text.'),
  tool('web_search', 'Search the public web for result titles, URLs and snippets.'),
  tool('research', 'Research a question across multiple sources.'),
  tool('browse', 'Open a URL or a web search in the browser.'),
  tool('browser_open', 'Open a URL in the browser and return its text.'),
  tool('browser_read', 'Read the open browser page.'),
  tool('site_open', 'Find a site from history and open it.'),
  tool('vault_search', 'Search the Obsidian vault for a phrase.'),
  tool('vault_read', 'Read a note from the vault.'),
  tool('search_notes', 'Search Lux notes for a phrase.'),
  tool('write_note', 'Save a markdown note.'),
  tool('commitments', 'Read the commitment ledger.'),
  tool('play_music', 'Play a track, album or playlist.'),
  tool('focus_preset', 'Apply a focus preset.'),
  tool('open_app', 'Open an application.'),
  tool('list_apps', 'List installed applications.'),
  tool('now_playing', 'Report what is playing.'),
  tool('music_taste', 'Read listening history and playlists.'),
  tool('timer', 'Start or list countdown timers.'),
  tool('job', 'Run one tool in the background.'),
  tool('run_shell', 'Run an approved shell command.'),
  tool('discover_tools', 'Discover capabilities not in the shortlist.')
]

export const EVAL_CASES: EvalCase[] = [
  // Reviewed plans.
  {
    id: 'plan-research',
    prompt: 'Research the current state of local LLM runtimes for a 16 GB Mac. Give at least two sources with their exact URLs.',
    playbook: 'research-brief',
    tool: 'research',
    citations: 2
  },
  {
    id: 'plan-compare',
    prompt: 'Compare two local model runners and recommend one for a 16 GB Mac. Give at least two sources.',
    playbook: 'compare-options',
    tool: 'research',
    citations: 2
  },
  {
    id: 'plan-release',
    prompt: 'What changed in the latest Ollama release? Include the URL you relied on.',
    playbook: 'latest-release',
    tool: 'research',
    citations: 1
  },
  {
    id: 'plan-file',
    prompt: "Find files on this Mac whose name contains 'screenshot'.",
    playbook: 'find-file',
    tool: 'find_files'
  },
  {
    id: 'plan-page',
    prompt: 'Read this page and summarise the main argument.',
    playbook: 'read-page',
    tool: 'web_read',
    citations: 1
  },
  {
    id: 'plan-recall',
    prompt: 'Find where I wrote down the deployment steps.',
    playbook: 'workspace-recall',
    tool: 'vault_search'
  },
  {
    id: 'plan-morning',
    prompt: 'What do I have to do today?',
    playbook: 'morning-review',
    tool: 'commitments'
  },
  {
    id: 'plan-system',
    prompt: 'How is this machine doing — CPU, memory and disk?',
    playbook: 'system-checkup',
    tool: 'system_status'
  },
  {
    id: 'plan-focus',
    prompt: 'Set up my study focus session.',
    playbook: 'desk-reset',
    tool: 'focus_preset'
  },
  {
    id: 'plan-survey',
    prompt: 'Survey the current state of local LLM runtimes and cite two sources.',
    playbook: 'research-brief',
    tool: 'research',
    citations: 2
  },

  // No action is the correct action.
  { id: 'answer-hello', prompt: 'Say hello in one short sentence.', answerOnly: true },
  { id: 'answer-time', prompt: 'What time is it right now?', answerOnly: true },
  { id: 'answer-how', prompt: 'How are you?', answerOnly: true },
  { id: 'answer-joke', prompt: 'Tell me a joke.', answerOnly: true },
  { id: 'answer-capital', prompt: 'What is the capital of France?', answerOnly: true },
  { id: 'answer-vector', prompt: 'Explain what a vector database is.', answerOnly: true },
  { id: 'answer-hamlet', prompt: 'Who wrote Hamlet?', answerOnly: true },
  { id: 'answer-capabilities', prompt: 'What can you do?', answerOnly: true },
  { id: 'answer-morning', prompt: 'Good morning.', answerOnly: true },
  { id: 'answer-summary', prompt: 'Give me a summary of this chat.', answerOnly: true },

  // A vague request gets one targeted question, not a guessed action.
  { id: 'clarify-music', prompt: 'Handle my music.', clarify: true },
  { id: 'clarify-yesterday', prompt: 'Deal with that thing from yesterday.', clarify: true },
  { id: 'clarify-stuff', prompt: 'Sort out my stuff.', clarify: true },
  { id: 'clarify-it', prompt: 'Take care of it.', clarify: true },
  { id: 'clarify-this', prompt: 'Fix this.', clarify: true },
  { id: 'clarify-thing', prompt: 'Look at that thing.', clarify: true },
  { id: 'clarify-something', prompt: 'Do something about the stuff.', clarify: true },
  { id: 'clarify-business', prompt: 'See to the business.', clarify: true },
  { id: 'clarify-one', prompt: 'Handle that one.', clarify: true },
  { id: 'clarify-the-thing', prompt: 'Deal with the thing.', clarify: true }
]
