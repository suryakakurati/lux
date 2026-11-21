import type { BenchTask } from '../../shared/bench'

/**
 * Fixed V.0 baseline turns.
 *
 * These are intentionally read-only: the tool context denies every confirmation
 * and the harness forbids every tool that could change this Mac, play audio or
 * write a note. A benchmark that modifies the machine is not repeatable.
 */
const NO_SIDE_EFFECTS = [
  'run_shell',
  'write_note',
  'clipboard_write',
  'set_volume',
  'toggle_appearance',
  'lock_screen',
  'sleep_display',
  'take_screenshot',
  'open_app',
  'quit_app',
  'open_url',
  'open_path',
  'quick_look',
  'play_music',
  'spotify_control',
  'apple_music_control',
  'remember',
  'commitments',
  'browser_click',
  'browser_fill',
  'browser_submit',
  'browser_press',
  'focus_preset',
  'save_playbook',
  'job'
]

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'battery',
    category: 'trivial',
    prompt: "What's my battery at?",
    expectedToolsAny: ['battery_status', 'system_status'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /%/,
    replyMaxChars: 500
  },
  {
    id: 'memory',
    category: 'trivial',
    prompt: 'How much memory is this Mac using right now?',
    expectedToolsAny: ['system_status'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /(GB|memory|%)/i,
    replyMaxChars: 700
  },
  {
    id: 'volume',
    category: 'trivial',
    prompt: "What's the output volume?",
    expectedToolsAny: ['get_volume', 'system_status'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /(%|volume)/i,
    replyMaxChars: 500
  },
  {
    id: 'time',
    category: 'trivial',
    prompt: 'What time is it right now?',
    forbiddenTools: NO_SIDE_EFFECTS,
    maxTools: 0,
    replyPattern: /(\d{1,2}:\d{2}|\bAM\b|\bPM\b)/i,
    replyMaxChars: 300
  },
  {
    id: 'hello',
    category: 'trivial',
    prompt: 'Say hello in one short sentence.',
    forbiddenTools: NO_SIDE_EFFECTS,
    maxTools: 0,
    replyMaxChars: 300
  },
  {
    id: 'system',
    category: 'one-tool',
    prompt: 'How is this machine doing — CPU, memory and disk?',
    expectedToolsAny: ['system_status'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /(CPU|memory|disk|load)/i,
    replyMaxChars: 1200
  },
  {
    id: 'clipboard',
    category: 'one-tool',
    prompt: "Read my clipboard and tell me what's on it.",
    expectedToolsAny: ['clipboard_read'],
    forbiddenTools: NO_SIDE_EFFECTS,
    // Clipboard content is arbitrary; a long answer can be the correct one.
    replyMaxChars: 4_000
  },
  {
    id: 'apps',
    category: 'one-tool',
    prompt: 'List a few apps installed on this Mac.',
    expectedToolsAny: ['list_apps'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /[A-Za-z]/,
    replyMaxChars: 1500
  },
  {
    id: 'files',
    category: 'one-tool',
    prompt: "Find files on this Mac whose name contains 'screenshot'.",
    expectedToolsAny: ['find_files'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMaxChars: 1500
  },
  {
    id: 'playing',
    category: 'one-tool',
    prompt: "What's playing on Spotify right now?",
    expectedToolsAny: ['now_playing', 'music_taste'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMaxChars: 900
  },
  {
    id: 'battery-clipboard',
    category: 'multi-tool',
    prompt: "What's my battery percentage and what's on my clipboard?",
    expectedToolsAll: ['battery_status', 'clipboard_read'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /%/,
    replyMaxChars: 4_000,
    maxRounds: 5
  },
  {
    id: 'volume-clipboard',
    category: 'multi-tool',
    prompt: "What's the output volume and what's on my clipboard?",
    expectedToolsAll: ['get_volume', 'clipboard_read'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMaxChars: 4_000,
    maxRounds: 5
  },
  {
    id: 'battery-files',
    category: 'multi-tool',
    prompt: "Check my battery, then find files named 'screenshot'.",
    expectedToolsAll: ['battery_status', 'find_files'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /%/,
    replyMaxChars: 1500,
    maxRounds: 5
  },
  {
    id: 'apps-clipboard',
    category: 'multi-tool',
    prompt: 'List a few installed apps and tell me what is on my clipboard.',
    expectedToolsAll: ['list_apps', 'clipboard_read'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMaxChars: 4_000,
    maxRounds: 5
  },
  {
    id: 'example-page',
    category: 'multi-tool',
    prompt: 'Open example.com in the browser, read the heading, and tell me the page title.',
    expectedToolsAny: ['browser_open', 'web_read'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /Example Domain/i,
    replyMaxChars: 800,
    maxRounds: 5
  },
  {
    id: 'research-runtimes',
    category: 'research',
    prompt:
      'Research the current state of local LLM runtimes for a 16 GB Mac. Give at least two sources, each with its exact URL.',
    expectedToolsAny: ['research', 'web_search'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMinChars: 250,
    requiredCitations: 2,
    requiredCitationHosts: 2,
    citationsFromEvidence: true,
    maxRounds: 8
  },
  {
    id: 'compare-runners',
    category: 'research',
    prompt:
      'Compare two local model runners and recommend one for a 16 GB Mac. Give at least two sources with their URLs.',
    expectedToolsAny: ['research', 'web_search'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMinChars: 250,
    requiredCitations: 2,
    requiredCitationHosts: 2,
    citationsFromEvidence: true,
    maxRounds: 8
  },
  {
    id: 'ollama-release',
    category: 'research',
    prompt:
      'What changed in the latest Ollama release? Use current sources and include the URL you relied on.',
    expectedToolsAny: ['research', 'web_search'],
    forbiddenTools: NO_SIDE_EFFECTS,
    replyPattern: /Ollama/i,
    replyMinChars: 120,
    requiredCitations: 1,
    requiredCitationHosts: 1,
    citationsFromEvidence: true,
    maxRounds: 8
  },
  {
    id: 'handle-music',
    category: 'ambiguous',
    prompt: 'Handle my music.',
    expectedToolsAny: ['music_taste', 'now_playing'],
    allowQuestionInsteadOfTools: true,
    forbiddenTools: NO_SIDE_EFFECTS,
    replyMaxChars: 900,
    maxRounds: 4
  },
  {
    id: 'yesterday-thing',
    category: 'ambiguous',
    prompt: 'Deal with that thing from yesterday.',
    expectQuestion: true,
    forbiddenTools: NO_SIDE_EFFECTS,
    maxTools: 1,
    replyMaxChars: 500,
    maxRounds: 4
  }
]
